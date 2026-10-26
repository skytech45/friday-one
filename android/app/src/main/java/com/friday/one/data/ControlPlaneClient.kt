package com.friday.one.data

import com.friday.one.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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
    /** Agents the connector reported on its last capability sync. */
    val agents: List<CloudAgent> = emptyList(),
    /** Project roots the connector is allowed to work in. */
    val projects: List<CloudProject> = emptyList(),
)

data class CloudAgent(
    val id: String,
    val adapter: String,
    val version: String?,
    val health: String,
)

data class CloudProject(val id: String, val root: String, val label: String?)

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
 * Control-plane REST client. EVERY network call runs on Dispatchers.IO —
 * OkHttp's execute() is blocking, and Android throws
 * NetworkOnMainThreadException if it runs on the composition (main) scope.
 * All methods are suspend for the same reason.
 */
class ControlPlaneClient {
    private val json = Json { ignoreUnknownKeys = true }
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    suspend fun listServers(accessToken: String): List<CloudServer> = withContext(Dispatchers.IO) {
        getArray(accessToken, "/api/v1/servers", "servers").map(::parseServer)
    }

    /** v2 enrollment: returns enrollment id + one-time install token. */
    suspend fun createEnrollment(accessToken: String, name: String): EnrollmentInfo = withContext(Dispatchers.IO) {
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
            EnrollmentInfo(s("enrollment_id"), s("server_id"), s("enrollment_token"), s("expires_at"))
        }
    }

    /** v2 claim: submit the 16-20 digit code shown on the server terminal. */
    suspend fun claimEnrollment(accessToken: String, enrollmentId: String, code: String): String = withContext(Dispatchers.IO) {
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
            "claim_requested"
        }
    }

    suspend fun revokeServer(accessToken: String, serverId: String): Unit = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}/api/v1/servers/$serverId/revoke")
            .header("Authorization", "Bearer $accessToken")
            .post(byteArrayOf().toRequestBody(null))
            .build()
        http.newCall(req).execute().use { if (!it.isSuccessful) error("revoke failed (${it.code})") }
    }

    // ---- policies / jobs / audit (plan v2 §10) ----------------------------
    suspend fun policies(accessToken: String): List<Policy> = withContext(Dispatchers.IO) {
        getArray(accessToken, "/api/v1/policies", "policies").map { obj ->
            Policy(
                id = obj.s("id"), serverId = obj.s("server_id").ifEmpty { "-" },
                serverName = obj.s("server_name").ifEmpty { "all servers" },
                action = obj.s("action"), decision = obj.s("decision"),
                enabled = obj.s("enabled") == "true",
            )
        }
    }

    suspend fun addPolicy(accessToken: String, serverId: String?, action: String, decision: String): Unit = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("action", action); put("decision", decision)
            serverId?.let { put("server_id", it) }
        }.toString().toRequestBody("application/json".toMediaType())
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}/api/v1/policies")
            .header("Authorization", "Bearer $accessToken").post(body).build()
        http.newCall(req).execute().use { if (!it.isSuccessful) error("add failed (${it.code})") }
    }

    suspend fun setPolicyEnabled(accessToken: String, id: String, enabled: Boolean): Unit = withContext(Dispatchers.IO) {
        patch(accessToken, "/api/v1/policies/$id", buildJsonObject { put("enabled", enabled) })
    }

    suspend fun deletePolicy(accessToken: String, id: String): Unit = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}/api/v1/policies/$id")
            .header("Authorization", "Bearer $accessToken").delete().build()
        http.newCall(req).execute().use { if (!it.isSuccessful) error("delete failed (${it.code})") }
    }

    suspend fun jobs(accessToken: String): List<Job> = withContext(Dispatchers.IO) {
        getArray(accessToken, "/api/v1/jobs", "jobs").map { obj ->
            Job(obj.s("id").take(8), obj.s("operation"), obj.s("state"), obj.s("updated_at").take(19))
        }
    }

    suspend fun audit(accessToken: String): List<AuditEvent> = withContext(Dispatchers.IO) {
        getArray(accessToken, "/api/v1/audit", "events").map { obj ->
            AuditEvent(obj.s("action"), obj.s("created_at").take(19).replace("T", " "))
        }
    }

    /**
     * Runtime gateway discovery: the control plane returns the current
     * gateway WSS URL from app_config (the tunnel service keeps it fresh),
     * so a tunnel rotation needs no APK rebuild. Falls back to null.
     */
    suspend fun gatewayUrl(accessToken: String?): String? = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}/api/v1/health")
            .apply { if (accessToken?.isNotEmpty() == true) header("Authorization", "Bearer $accessToken") }
            .get().build()
        runCatching {
            http.newCall(req).execute().use { resp ->
                val text = resp.body?.string() ?: return@withContext null
                (json.parseToJsonElement(text) as? JsonObject)?.get("gateway_url")
                    ?.toString()?.trim('"')?.ifEmpty { null }
            }
        }.getOrNull()
    }

    private suspend fun getArray(accessToken: String, path: String, key: String): List<JsonObject> = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}$path")
            .header("Authorization", "Bearer $accessToken").get().build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            if (!resp.isSuccessful) error("$path failed (${resp.code})")
            val obj = json.parseToJsonElement(text) as? JsonObject ?: return@withContext emptyList()
            (obj[key] as? kotlinx.serialization.json.JsonArray)
                ?.mapNotNull { it as? JsonObject } ?: emptyList()
        }
    }

    private suspend fun patch(accessToken: String, path: String, body: JsonObject): Unit = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("${BuildConfig.CONTROL_PLANE_URL}$path")
            .header("Authorization", "Bearer $accessToken")
            .patch(body.toString().toRequestBody("application/json".toMediaType())).build()
        http.newCall(req).execute().use { if (!it.isSuccessful) error("patch failed (${it.code})") }
    }

    /** Dashboard row + discovered capabilities. Pure so it is unit-tested. */
    internal fun parseServer(obj: JsonObject): CloudServer = CloudServer(
        id = obj.s("id"), name = obj.s("name"),
        enrollmentState = obj.s("enrollment_state"),
        online = obj.s("online") == "true",
        agents = obj.array("agents").mapNotNull { a ->
            val id = a.s("id")
            val adapter = a.s("adapter")
            if (id.isEmpty() || adapter.isEmpty()) null
            else CloudAgent(id, adapter, a.sOrNull("version"), a.s("health"))
        },
        projects = obj.array("projects").mapNotNull { p ->
            val root = p.s("root")
            if (root.isEmpty()) null
            else CloudProject(p.s("id"), root, p.sOrNull("label"))
        },
    )

    private fun JsonObject.s(k: String): String = this[k]?.toString()?.trim('"') ?: ""

    private fun JsonObject.sOrNull(k: String): String? {
        val v = this[k] ?: return null
        if (v is kotlinx.serialization.json.JsonNull) return null
        return v.toString().trim('"').ifEmpty { null }
    }

    private fun JsonObject.array(k: String): List<JsonObject> =
        (this[k] as? kotlinx.serialization.json.JsonArray)
            ?.mapNotNull { it as? JsonObject } ?: emptyList()
}
