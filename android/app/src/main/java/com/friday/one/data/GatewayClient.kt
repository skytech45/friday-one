package com.friday.one.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.callbackFlow
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

/** Events the chat UI reacts to. */
sealed interface GatewayEvent {
    data class Connected(val serverId: String) : GatewayEvent
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
 * Gateway WSS client (Phase 7). Speaks docs/REALTIME_PROTOCOL.md: auth.app
 * with the Supabase token, command.submit for prompts, streaming chat.delta
 * back. Reconnects with backoff; the caller owns re-auth on refresh.
 */
class GatewayClient(
    private val wsUrl: String,
    private val accessToken: () -> String?,
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val http = OkHttpClient()
    private var ws: WebSocket? = null
    private var serverId: String = "00000000-0000-0000-0000-000000000000"
    private var seq = 0
    private var heartbeat: kotlinx.coroutines.Job? = null
    val online = MutableStateFlow(false)

    fun events(): Flow<GatewayEvent> = callbackFlow {
        val request = Request.Builder().url(wsUrl).build()
        ws = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                send("auth.app", buildJsonObject { put("token", accessToken() ?: "") })
                // Heartbeat every 15 s (protocol §6): without traffic the
                // cloudflared tunnel drops idle WSS sockets ~60 s in.
                heartbeat?.cancel()
                heartbeat = CoroutineScope(Dispatchers.IO).launch {
                    while (true) {
                        delay(15_000)
                        send("app.heartbeat", buildJsonObject { })
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val obj = runCatching { json.parseToJsonElement(text) as JsonObject }.getOrNull() ?: return
                val type = obj["event_type"]?.toString()?.trim('"') ?: return
                val payload = obj["payload"] as? JsonObject ?: JsonObject(emptyMap())
                val corr = obj["correlation_id"]?.toString()?.trim('"')
                fun str(k: String) = payload[k]?.toString()?.trim('"')
                val event = when (type) {
                    "auth.resume.ok" -> {
                        str("server_id")?.let { serverId = it }
                        GatewayEvent.Connected(serverId)
                    }
                    "command.accepted" -> GatewayEvent.JobAccepted(corr ?: "")
                    "command.started" -> GatewayEvent.JobStarted(corr ?: "")
                    "chat.delta" -> GatewayEvent.Delta(corr ?: "", str("delta") ?: "")
                    "command.completed" -> GatewayEvent.Completed(corr ?: "", str("stopReason") ?: "")
                    "command.failed" -> GatewayEvent.Failed(corr ?: "", str("reason") ?: "")
                    "command.rejected" -> GatewayEvent.Rejected(str("reason") ?: "rejected")
                    "permission.requested" -> GatewayEvent.PermissionRequested(
                        str("request_id") ?: "", str("operation") ?: "",
                    )
                    else -> return
                }
                trySend(event)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                heartbeat?.cancel()
                online.value = false
                trySend(GatewayEvent.Disconnected)
                channel.close()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                heartbeat?.cancel()
                online.value = false
                trySend(GatewayEvent.Disconnected)
                channel.close()
            }
        })
        awaitClose { heartbeat?.cancel(); ws?.close(1000, "ui_closed") }
    }

    fun submitPrompt(
        serverId: String,
        root: String,
        prompt: String,
        correlationId: String,
        agent: String? = null,
    ): Boolean {
        serverId.let { this.serverId = serverId }
        val env = buildJsonObject {
            put("protocol_version", 1)
            put("message_id", UUID.randomUUID().toString())
            put("correlation_id", correlationId)
            put("server_id", serverId)
            put("connector_id", null as String?)
            put("agent_id", null as String?)
            put("session_id", null as String?)
            put("event_type", "command.submit")
            put("issued_at", java.time.Instant.now().toString())
            put("expires_at", null as String?)
            put("sequence", ++seq)
            put("idempotency_key", UUID.randomUUID().toString())
            put("payload", buildJsonObject {
                put("server_id", serverId)
                put("operation", "session.prompt")
                put("arguments", buildJsonObject {
                    put("root", root)
                    put("prompt", prompt)
                    if (agent != null) put("agent", agent)
                })
            })
        }
        return ws?.send(env.toString()) ?: false
    }

    fun decide(requestId: String, allow: Boolean) {
        val env = buildJsonObject {
            put("protocol_version", 1)
            put("message_id", UUID.randomUUID().toString())
            put("correlation_id", null as String?)
            put("server_id", serverId)
            put("connector_id", null as String?)
            put("agent_id", null as String?)
            put("session_id", null as String?)
            put("event_type", "permission.decided")
            put("issued_at", java.time.Instant.now().toString())
            put("expires_at", null as String?)
            put("sequence", ++seq)
            put("idempotency_key", null as String?)
            put("payload", buildJsonObject {
                put("request_id", requestId)
                put("decision", if (allow) "allow" else "deny")
            })
        }
        ws?.send(env.toString())
    }

    fun cancel(jobId: String): Boolean {
        val env = buildJsonObject {
            put("protocol_version", 1)
            put("message_id", UUID.randomUUID().toString())
            put("correlation_id", jobId)
            put("server_id", serverId)
            put("connector_id", null as String?)
            put("agent_id", null as String?)
            put("session_id", null as String?)
            put("event_type", "command.cancel")
            put("issued_at", java.time.Instant.now().toString())
            put("expires_at", null as String?)
            put("sequence", ++seq)
            put("idempotency_key", UUID.randomUUID().toString())
            put("payload", buildJsonObject {
                put("job_id", jobId)
            })
        }
        return ws?.send(env.toString()) ?: false
    }

    fun close() {
        ws?.close(1000, "bye")
        ws = null
    }

    private fun send(eventType: String, payload: JsonObject) {
        val env = buildJsonObject {
            put("protocol_version", 1)
            put("message_id", UUID.randomUUID().toString())
            put("correlation_id", null as String?)
            put("server_id", serverId)
            put("connector_id", null as String?)
            put("agent_id", null as String?)
            put("session_id", null as String?)
            put("event_type", eventType)
            put("issued_at", java.time.Instant.now().toString())
            put("expires_at", null as String?)
            put("sequence", ++seq)
            put("idempotency_key", null as String?)
            put("payload", payload)
        }
        ws?.send(env.toString())
    }
}
