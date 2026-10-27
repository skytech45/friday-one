package com.friday.one.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

/**
 * Reconnect behaviour against a real WebSocket server: Cloud Run ends every
 * socket at its request timeout, so reconnecting must be routine, use a
 * fresh token each time, and never replay a command.
 */
class GatewayClientTest {
    private lateinit var server: MockWebServer
    private val json = Json { ignoreUnknownKeys = true }
    private val fastBackoff = Backoff(baseMs = 20, capMs = 50, minMs = 5)

    /** One server-side connection: what it received, and its socket. */
    private class Conn {
        val received = CopyOnWriteArrayList<JsonObject>()
        @Volatile var socket: WebSocket? = null
        fun types() = received.map { it["event_type"]!!.jsonPrimitive.content }
    }

    private val conns = CopyOnWriteArrayList<Conn>()

    /** Server side: answers auth.app with auth.resume.ok, or refuses with [refuseCode]. */
    private fun upgrade(refuseCode: Int? = null, answerClose: Boolean = true): MockResponse {
        val conn = Conn().also { conns += it }
        return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                conn.socket = webSocket
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (answerClose) webSocket.close(code, null) // as the real gateway does
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val env = json.parseToJsonElement(text).jsonObject
                conn.received += env
                if (env["event_type"]!!.jsonPrimitive.content == "auth.app") {
                    if (refuseCode != null) {
                        webSocket.close(refuseCode, "invalid_token")
                    } else {
                        webSocket.send(
                            """{"event_type":"auth.resume.ok","payload":{"user_id":"u1"},"correlation_id":null}""",
                        )
                    }
                }
            }
        })
    }

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun wsUrl() = server.url("/").toString().replaceFirst("http", "ws")

    private fun collect(client: GatewayClient, events: MutableList<GatewayEvent>): Job =
        CoroutineScope(Dispatchers.IO).launch { client.events().collect { events += it } }

    private suspend fun waitUntil(what: String, timeoutMs: Long = 5_000, cond: () -> Boolean) {
        withTimeout(timeoutMs) { while (!cond()) delay(10) }
        assertTrue(what, cond())
    }

    @Test
    fun `reconnects after the server drops the socket, with a fresh token and no replay`() = runBlocking {
        server.enqueue(upgrade())
        server.enqueue(upgrade())
        val tokenCalls = AtomicInteger(0)
        val client = GatewayClient(wsUrl(), { "token-${tokenCalls.incrementAndGet()}" }, backoff = fastBackoff)
        val events = CopyOnWriteArrayList<GatewayEvent>()
        val job = collect(client, events)

        waitUntil("first connect") { events.count { it is GatewayEvent.Connected } == 1 }
        assertTrue(client.submitPrompt("s1", "/srv/app", "hello", "corr-1"))
        waitUntil("submit reached the server") { conns[0].types().contains("command.submit") }

        conns[0].socket!!.close(1001, "request timeout") // what Cloud Run does at 60 min
        waitUntil("reconnecting announced") { events.any { it is GatewayEvent.Reconnecting } }
        waitUntil("second connect") { events.count { it is GatewayEvent.Connected } == 2 }

        val secondAuth = conns[1].received.first()
        assertEquals("auth.app", secondAuth["event_type"]!!.jsonPrimitive.content)
        assertEquals("token-2", secondAuth["payload"]!!.jsonObject["token"]!!.jsonPrimitive.content)
        assertFalse("nothing is replayed after a reconnect", conns[1].types().contains("command.submit"))
        val lastSeqBefore = conns[0].received.last()["sequence"]!!.jsonPrimitive.long
        assertTrue("sequence keeps increasing across sockets", secondAuth["sequence"]!!.jsonPrimitive.long > lastSeqBefore)

        job.cancel()
    }

    @Test
    fun `sends while disconnected fail instead of being queued`() = runBlocking {
        server.enqueue(upgrade())
        val client = GatewayClient(wsUrl(), { "t" }, backoff = Backoff(baseMs = 60_000, capMs = 60_000, minMs = 59_000))
        val events = CopyOnWriteArrayList<GatewayEvent>()
        val job = collect(client, events)
        waitUntil("connected") { events.any { it is GatewayEvent.Connected } }
        conns[0].socket!!.close(1001, "gone")
        waitUntil("reconnecting") { events.any { it is GatewayEvent.Reconnecting } }

        assertFalse(client.submitPrompt("s1", "/srv/app", "hello", "corr-2"))
        assertFalse(client.cancel("job-1"))
        job.cancel()
    }

    @Test
    fun `two refused logins in a row stop with AuthFailed`() = runBlocking {
        repeat(3) { server.enqueue(upgrade(refuseCode = 4403)) }
        val client = GatewayClient(wsUrl(), { "bad" }, backoff = fastBackoff)
        val events = CopyOnWriteArrayList<GatewayEvent>()
        val job = collect(client, events)
        waitUntil("auth failed") { events.contains(GatewayEvent.AuthFailed) }
        delay(200)
        assertEquals("no third attempt", 2, server.requestCount)
        job.join()
    }

    @Test
    fun `missing token stops before connecting`() = runBlocking {
        val client = GatewayClient(wsUrl(), { null }, backoff = fastBackoff)
        val events = CopyOnWriteArrayList<GatewayEvent>()
        collect(client, events).join()
        assertEquals(listOf<GatewayEvent>(GatewayEvent.AuthFailed), events)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `an unreachable gateway is retried with growing attempts`() = runBlocking {
        val port = server.port
        server.shutdown() // nothing listens any more
        val tokenCalls = AtomicInteger(0)
        val client = GatewayClient("ws://127.0.0.1:$port/", { tokenCalls.incrementAndGet(); "t" }, backoff = fastBackoff)
        val events = CopyOnWriteArrayList<GatewayEvent>()
        val job = collect(client, events)
        waitUntil("three retries") { events.filterIsInstance<GatewayEvent.Reconnecting>().size >= 3 }
        job.cancel()
        val attempts = events.filterIsInstance<GatewayEvent.Reconnecting>().map { it.attempt }.take(3)
        assertEquals(listOf(1, 2, 3), attempts)
        assertTrue("a token is fetched for every attempt", tokenCalls.get() >= 3)
    }

    @Test
    fun `close stops reconnecting`() = runBlocking {
        server.enqueue(upgrade())
        server.enqueue(upgrade())
        val client = GatewayClient(wsUrl(), { "t" }, backoff = fastBackoff)
        val events = CopyOnWriteArrayList<GatewayEvent>()
        val job = collect(client, events)
        waitUntil("connected") { events.any { it is GatewayEvent.Connected } }
        client.close()
        withTimeout(5_000) { job.join() }
        assertEquals(1, server.requestCount)
        assertFalse(events.any { it is GatewayEvent.Reconnecting })
    }

    @Test
    fun `close ends the session promptly even if the server never answers the close`() = runBlocking {
        server.enqueue(upgrade(answerClose = false))
        val client = GatewayClient(wsUrl(), { "t" }, backoff = fastBackoff)
        val events = CopyOnWriteArrayList<GatewayEvent>()
        val job = collect(client, events)
        waitUntil("connected") { events.any { it is GatewayEvent.Connected } }
        client.close()
        withTimeout(2_000) { job.join() } // OkHttp's own close timeout would be 60 s
        assertEquals(1, server.requestCount)
        // Finish the handshake the server deliberately ignored, so teardown can stop.
        conns[0].socket?.close(1000, null)
        Unit
    }

    @Test
    fun `job ids come from the payload and stop reasons from the result summary`() {
        val client = GatewayClient("ws://unused", { "t" })
        val accepted = client.parse(
            """{"event_type":"command.accepted","correlation_id":"dispatch-msg-id","payload":{"job_id":"job-123","agent":"opencode"}}""",
        )
        assertEquals(GatewayEvent.JobAccepted("job-123"), accepted)
        val done = client.parse(
            """{"event_type":"command.completed","correlation_id":"x","payload":{"job_id":"job-123","result_summary":{"stopReason":"end_turn"}}}""",
        )
        assertEquals(GatewayEvent.Completed("job-123", "end_turn"), done)
        assertEquals(null, client.parse("not json"))
    }

    @Test
    fun `backoff grows exponentially with full jitter under the cap`() {
        val b = Backoff(baseMs = 1_000, capMs = 30_000, minMs = 250, random = Random(42))
        repeat(200) {
            assertTrue(b.delayFor(1) in 250..1_000)
            assertTrue(b.delayFor(3) in 250..4_000)
            assertTrue(b.delayFor(10) in 250..30_000)
            assertTrue(b.delayFor(100) in 250..30_000)
        }
        val high = (1..200).map { b.delayFor(6) }
        assertTrue("jitter spreads retries", high.toSet().size > 50)
    }
}
