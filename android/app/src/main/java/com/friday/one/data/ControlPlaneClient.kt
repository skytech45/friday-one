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

data class Policy(
    val id: String,
    val serverId: String,
    val serverName: String,
    val action: String,
    val decision: String,
    val enabled: Boolean,
)

data class Job(val id: String, val operation: String, val state: String, val updated: String)

data class AuditEvent(val action: String, val at: String)

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

    // ---- policies / jobs / audit (plan v2 §10) ----------------------------
    fun policies(accessToken: String): List<Policy> {
        val arr = getArray(accessToken, "/api/v1/policies", "policies")
        return arr.map { obj ->
            Policy(
                id = obj.s("id"), serverId = obj.s("server_id").ifEmpty { "-" },
                serverName = obj.s("server_name").ifEmpty { "all servers" },
                action = obj.s("action"), decision = obj.s("decision"),
                enabled = obj.s("enabled") == "true",
            )
        }
    }

    fun addPolicy(accessToken: String, serverId: String?, action: String, decision: String) {
        val body = buildJsonObject {
            put("action", action); put("decision", decision)
            serverId?.let { put("server_id", it) }
        }.toString().toRequestBody("application/json".toMediaType())
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}/api/v1/policies")
            .header("Authorization", "Bearer $accessToken").post(body).build()
        http.newCall(req).execute().use { if (!it.isSuccessful) error("add failed (${it.code})") }
    }

    fun setPolicyEnabled(accessToken: String, id: String, enabled: Boolean) {
        patch(accessToken, "/api/v1/policies/$id", buildJsonObject { put("enabled", enabled) })
    }

    fun deletePolicy(accessToken: String, id: String) {
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}/api/v1/policies/$id")
            .header("Authorization", "Bearer $accessToken").delete().build()
        http.newCall(req).execute().use { if (!it.isSuccessful) error("delete failed (${it.code})") }
    }

    fun jobs(accessToken: String): List<Job> =
        getArray(accessToken, "/api/v1/jobs", "jobs").map { obj ->
            Job(obj.s("id").take(8), obj.s("operation"), obj.s("state"), obj.s("updated_at").take(19))
        }

    fun audit(accessToken: String): List<AuditEvent> =
        getArray(accessToken, "/api/v1/audit", "events").map { obj ->
            AuditEvent(obj.s("action"), obj.s("created_at").take(19).replace("T", " "))
        }

    private fun getArray(accessToken: String, path: String, key: String): List<JsonObject> {
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}$path")
            .header("Authorization", "Bearer $accessToken").get().build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            if (!resp.isSuccessful) error("$path failed (${resp.code})")
            val obj = json.parseToJsonElement(text) as? JsonObject ?: return emptyList()
            return (obj[key] as? kotlinx.serialization.json.JsonArray)
                ?.mapNotNull { it as? JsonObject } ?: emptyList()
        }
    }

    private fun patch(accessToken: String, path: String, body: JsonObject) {
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}$path")
            .header("Authorization", "Bearer $accessToken")
            .patch(body.toString().toRequestBody("application/json".toMediaType())).build()
        http.newCall(req).execute().use { if (!it.isSuccessful) error("patch failed (${it.code})") }
    }

    private fun JsonObject.s(k: String): String = this[k]?.toString()?.trim('"') ?: ""

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
