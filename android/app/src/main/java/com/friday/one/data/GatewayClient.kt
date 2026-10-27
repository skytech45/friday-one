package com.friday.one.data

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random

/** Events the chat UI reacts to. */
sealed interface GatewayEvent {
    data class Connected(val serverId: String) : GatewayEvent
    /** The socket dropped; the client will retry after [delayMs]. */
    data class Reconnecting(val attempt: Int, val delayMs: Long) : GatewayEvent
    /** The gateway refused our identity twice in a row; sign in again. */
    data object AuthFailed : GatewayEvent
    data class JobAccepted(val jobId: String) : GatewayEvent
    data class JobStarted(val jobId: String) : GatewayEvent
    data class Delta(val jobId: String, val text: String) : GatewayEvent
    data class Completed(val jobId: String, val stopReason: String) : GatewayEvent
    data class Failed(val jobId: String, val reason: String) : GatewayEvent
    data class Rejected(val reason: String) : GatewayEvent
    data class PermissionRequested(val requestId: String, val operation: String) : GatewayEvent
    data object Disconnected : GatewayEvent
}

/**
 * Exponential backoff with full jitter: attempt n waits a random time in
 * [min, min(cap, base·2^(n-1))]. Jitter keeps many clients from reconnecting
 * in lockstep after a gateway restart.
 */
class Backoff(
    private val baseMs: Long = 1_000,
    private val capMs: Long = 30_000,
    private val minMs: Long = 250,
    private val random: Random = Random.Default,
) {
    fun delayFor(attempt: Int): Long {
        val ceiling = (baseMs shl (attempt - 1).coerceIn(0, 20)).coerceAtMost(capMs)
        return random.nextLong(minMs, maxOf(minMs + 1, ceiling + 1))
    }
}

/**
 * Gateway WSS client (docs/REALTIME_PROTOCOL.md): `auth.app` with the
 * current ID token, `command.submit` for prompts, streaming `chat.delta` back.
 *
 * Reconnects with backoff for as long as [events] is collected. Cloud Run
 * ends every WebSocket at its request timeout (≤ 60 min), so this is normal
 * operation, not an error path. Each connect fetches a FRESH token from
 * [accessToken]. Messages are never queued or replayed across a reconnect:
 * a submit while disconnected returns false, so a prompt can never run twice
 * because of a dropped socket (the gateway also rejects repeated idempotency
 * keys). Output the gateway sent during the gap is not recovered.
 */
class GatewayClient(
    private val wsUrl: String,
    private val accessToken: suspend () -> String?,
    private val http: OkHttpClient = OkHttpClient(),
    private val backoff: Backoff = Backoff(),
    private val heartbeatMs: Long = 15_000,
) {
    private val json = Json { ignoreUnknownKeys = true }
    @Volatile private var ws: WebSocket? = null
    @Volatile private var serverId: String = "00000000-0000-0000-0000-000000000000"
    /** Set by [close]: the current socket ends and no reconnect follows. */
    @Volatile private var stopped = false
    /** Completes when the current socket ends; [close] completes it directly. */
    @Volatile private var current: CompletableDeferred<Outcome>? = null
    private val seq = AtomicLong(0)
    val online = MutableStateFlow(false)

    private data class Outcome(val code: Int, val authenticated: Boolean, val closedByUs: Boolean)

    fun events(): Flow<GatewayEvent> = channelFlow {
        var attempt = 0
        var authFailures = 0
        while (isActive && !stopped) {
            val token = accessToken()
            if (token.isNullOrBlank()) {
                send(GatewayEvent.AuthFailed)
                break
            }
            val outcome = connectOnce(token)
            online.value = false
            if (outcome.closedByUs || stopped) {
                send(GatewayEvent.Disconnected)
                break
            }
            if (!outcome.authenticated && outcome.code in AUTH_REFUSED) {
                // One retry with a newly fetched token covers a token that
                // expired in flight; a second refusal means sign in again.
                if (++authFailures >= 2) {
                    send(GatewayEvent.AuthFailed)
                    break
                }
            } else if (outcome.authenticated) {
                authFailures = 0
            }
            attempt = if (outcome.authenticated) 1 else attempt + 1
            val wait = backoff.delayFor(attempt)
            send(GatewayEvent.Disconnected)
            send(GatewayEvent.Reconnecting(attempt, wait))
            delay(wait)
        }
    }

    /** One socket lifetime: open, authenticate, relay events, return how it ended. */
    private suspend fun ProducerScope<GatewayEvent>.connectOnce(token: String): Outcome {
        val ended = CompletableDeferred<Outcome>().also { current = it }
        if (stopped) ended.complete(Outcome(1000, authenticated = false, closedByUs = true))
        var authenticated = false
        val heartbeat = launch {
            while (isActive) {
                delay(heartbeatMs)
                if (authenticated) sendEnvelope("app.heartbeat", buildJsonObject { })
            }
        }
        val socket = http.newWebSocket(Request.Builder().url(wsUrl).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                ws = webSocket
                sendEnvelope("auth.app", buildJsonObject { put("token", token) })
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val event = parse(text) ?: return
                if (event is GatewayEvent.Connected) {
                    authenticated = true
                    online.value = true
                }
                trySend(event)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                ended.complete(Outcome(code, authenticated, stopped))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                ended.complete(Outcome(-1, authenticated, stopped))
            }
        })
        try {
            return ended.await()
        } finally {
            heartbeat.cancel()
            if (ws === socket) ws = null
            // Collector gone (screen closed) or close() called, possibly before
            // the socket opened: make sure this socket does not linger.
            if (!ended.isCompleted || stopped) socket.close(1000, "ui_closed")
        }
    }

    /** Envelope → UI event. Job IDs come from the payload, not correlation_id. */
    internal fun parse(text: String): GatewayEvent? {
        val obj = runCatching { json.parseToJsonElement(text) as JsonObject }.getOrNull() ?: return null
        val type = obj["event_type"]?.toString()?.trim('"') ?: return null
        val payload = obj["payload"] as? JsonObject ?: JsonObject(emptyMap())
        fun str(o: JsonObject, k: String) = o[k]?.toString()?.trim('"')?.takeIf { it != "null" }
        val jobId = str(payload, "job_id") ?: str(obj, "correlation_id") ?: ""
        return when (type) {
            "auth.resume.ok" -> {
                str(payload, "server_id")?.let { serverId = it }
                GatewayEvent.Connected(serverId)
            }
            "command.accepted" -> GatewayEvent.JobAccepted(jobId)
            "command.started" -> GatewayEvent.JobStarted(jobId)
            "chat.delta" -> GatewayEvent.Delta(jobId, str(payload, "delta") ?: "")
            "command.completed" -> GatewayEvent.Completed(
                jobId,
                (payload["result_summary"] as? JsonObject)?.let { str(it, "stopReason") } ?: "",
            )
            "command.failed" -> GatewayEvent.Failed(jobId, str(payload, "reason") ?: "")
            "command.rejected" -> GatewayEvent.Rejected(str(payload, "reason") ?: "rejected")
            "permission.requested" -> GatewayEvent.PermissionRequested(
                str(payload, "request_id") ?: "", str(payload, "operation") ?: "",
            )
            else -> null
        }
    }

    fun submitPrompt(
        serverId: String,
        root: String,
        prompt: String,
        correlationId: String,
        agent: String? = null,
    ): Boolean {
        this.serverId = serverId
        return sendEnvelope("command.submit", buildJsonObject {
            put("server_id", serverId)
            put("operation", "session.prompt")
            put("arguments", buildJsonObject {
                put("root", root)
                put("prompt", prompt)
                if (agent != null) put("agent", agent)
            })
        }, correlationId = correlationId, idempotencyKey = UUID.randomUUID().toString())
    }

    fun decide(requestId: String, allow: Boolean) {
        sendEnvelope("permission.decided", buildJsonObject {
            put("request_id", requestId)
            put("decision", if (allow) "allow" else "deny")
        })
    }

    fun cancel(jobId: String): Boolean =
        sendEnvelope("command.cancel", buildJsonObject { put("job_id", jobId) }, correlationId = null, idempotencyKey = UUID.randomUUID().toString())

    /** Ends the session for good: closes the socket and stops reconnecting. */
    fun close() {
        stopped = true
        ws?.close(1000, "bye")
        ws = null
        // Don't wait for the server's half of the closing handshake.
        current?.complete(Outcome(1000, authenticated = false, closedByUs = true))
    }

    /** Sends on the current socket only; false (and nothing queued) when offline. */
    private fun sendEnvelope(
        eventType: String,
        payload: JsonObject,
        correlationId: String? = null,
        idempotencyKey: String? = null,
    ): Boolean {
        val socket = ws ?: return false
        val env = buildJsonObject {
            put("protocol_version", 1)
            put("message_id", UUID.randomUUID().toString())
            put("correlation_id", correlationId)
            put("server_id", serverId)
            put("connector_id", null as String?)
            put("agent_id", null as String?)
            put("session_id", null as String?)
            put("event_type", eventType)
            put("issued_at", java.time.Instant.now().toString())
            put("expires_at", null as String?)
            put("sequence", seq.incrementAndGet())
            put("idempotency_key", idempotencyKey)
            put("payload", payload)
        }
        return socket.send(env.toString())
    }

    private companion object {
        /** Gateway close codes for a refused identity (docs/REALTIME_PROTOCOL.md). */
        val AUTH_REFUSED = setOf(4401, 4403)
    }
}
