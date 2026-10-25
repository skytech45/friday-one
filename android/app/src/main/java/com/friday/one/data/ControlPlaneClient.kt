package com.friday.one.data

import com.friday.one.BuildConfig
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.UUID
import java.util.concurrent.TimeUnit

/** A server row as the dashboard shows it. */
data class CloudServer(
    val id: String,
    val name: String,
    val enrollmentState: String,
    val online: Boolean,
)

/**
 * Control-plane REST client: list servers, create an enrollment (pairing
 * code). Authenticated with the Supabase access token — identity is derived
 * server-side from that token.
 */
class ControlPlaneClient {
    private val json = Json { ignoreUnknownKeys = true }
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    fun listServers(accessToken: String): List<CloudServer> {
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}/api/v1/servers")
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            if (!resp.isSuccessful) error("list failed (${resp.code})")
            val arr = json.parseToJsonElement(text)
                .let { (it as? JsonObject)?.get("servers") } ?: return emptyList()
            return json.decodeFromString(
                kotlinx.serialization.builtins.ListSerializer(CloudServerDto.serializer()),
                arr.toString(),
            ).map { CloudServer(it.id, it.name, it.enrollment_state, it.online) }
        }
    }

    /** Returns the single-use pairing code to type into the connector. */
    fun createEnrollment(accessToken: String, name: String): Pair<String, String> {
        val body = buildJsonObject { put("name", name) }
            .toString().toRequestBody("application/json".toMediaType())
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}/api/v1/servers/enrollments")
            .header("Authorization", "Bearer $accessToken")
            .post(body)
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            if (!resp.isSuccessful) error("enrollment failed (${resp.code})")
            val obj = json.parseToJsonElement(text) as JsonObject
            val serverId = obj["server_id"]?.toString()?.trim('"') ?: error("no server_id")
            val code = obj["code"]?.toString()?.trim('"') ?: error("no code")
            return serverId to code
        }
    }

    companion object {
        fun newJobId(): String = UUID.randomUUID().toString()
    }
}

@kotlinx.serialization.Serializable
private data class CloudServerDto(
    val id: String,
    val name: String,
    val enrollment_state: String,
    val online: Boolean,
)
