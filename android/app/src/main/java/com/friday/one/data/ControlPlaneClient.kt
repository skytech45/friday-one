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

data class EnrollmentInfo(
    val enrollmentId: String,
    val serverId: String,
    val token: String,
    val expiresAt: String,
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

    /** v2 enrollment: returns enrollment id + one-time install token. */
    fun createEnrollment(accessToken: String, name: String): EnrollmentInfo {
        val body = buildJsonObject { put("name", name) }
            .toString().toRequestBody("application/json".toMediaType())
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}/api/v1/enrollments")
            .header("Authorization", "Bearer $accessToken")
            .post(body)
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            if (!resp.isSuccessful) error("enrollment failed (${resp.code})")
            val obj = json.parseToJsonElement(text) as JsonObject
            fun s(k: String) = obj[k]?.toString()?.trim('"') ?: error("no $k")
            return EnrollmentInfo(s("enrollment_id"), s("server_id"), s("enrollment_token"), s("expires_at"))
        }
    }

    /** v2 claim: submit the 16-20 digit code shown on the server terminal. */
    fun claimEnrollment(accessToken: String, enrollmentId: String, code: String): String {
        val body = buildJsonObject { put("code", code) }
            .toString().toRequestBody("application/json".toMediaType())
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}/api/v1/enrollments/$enrollmentId/claim")
            .header("Authorization", "Bearer $accessToken")
            .post(body)
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            if (!resp.isSuccessful) {
                val reason = (json.parseToJsonElement(text) as? JsonObject)
                    ?.get("error")?.toString()?.trim('"') ?: "${resp.code}"
                error("claim failed: $reason")
            }
            return "claim_requested"
        }
    }

    fun revokeServer(accessToken: String, serverId: String) {
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}/api/v1/servers/$serverId/revoke")
            .header("Authorization", "Bearer $accessToken")
            .post(byteArrayOf().toRequestBody(null))
            .build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) error("revoke failed (${resp.code})")
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
