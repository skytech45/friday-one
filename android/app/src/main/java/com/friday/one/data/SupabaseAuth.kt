package com.friday.one.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.friday.one.BuildConfig
import kotlinx.coroutines.flow.first
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Supabase Auth for the cloud stack (Phase 7). Email+password sign-in/signup
 * against /auth/v1 with the PUBLISHABLE key — which is public by design; all
 * authorization happens server-side (RLS + control-plane verification).
 */
private val Context.cloudStore by preferencesDataStore(name = "friday_cloud")

@Serializable
data class CloudSession(
    val accessToken: String,
    val refreshToken: String,
    val userId: String,
    val email: String,
)

class SupabaseAuth(private val context: Context) {
    private val json = Json { ignoreUnknownKeys = true }
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    suspend fun save(session: CloudSession) {
        context.cloudStore.edit { p ->
            p[Keys.access] = session.accessToken
            p[Keys.refresh] = session.refreshToken
            p[Keys.userId] = session.userId
            p[Keys.email] = session.email
        }
    }

    suspend fun current(): CloudSession? {
        val p = context.cloudStore.data.first()
        val access = p[Keys.access] ?: return null
        return CloudSession(access, p[Keys.refresh] ?: "", p[Keys.userId] ?: "", p[Keys.email] ?: "")
    }

    suspend fun clear() {
        context.cloudStore.edit { it.clear() }
    }

    suspend fun login(email: String, password: String): Result<CloudSession> =
        authCall("token?grant_type=password", email, password)

    suspend fun signup(email: String, password: String): Result<CloudSession> =
        authCall("signup", email, password)

    private fun authCall(path: String, email: String, password: String): Result<CloudSession> = runCatching {
        val body = """{"email":${jsonStr(email)},"password":${jsonStr(password)}}"""
            .toRequestBody("application/json".toMediaType())
        val req = Request.Builder()
            .url("${BuildConfig.SUPABASE_URL}/auth/v1/$path")
            .header("apikey", BuildConfig.SUPABASE_PUBLISHABLE_KEY)
            .post(body)
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            if (!resp.isSuccessful) {
                val detail = runCatching {
                    json.parseToJsonElement(text).jsonObjectOrNull()?.get("msg")?.toString()
                }.getOrNull()
                error("auth failed (${resp.code})${detail?.let { ": ${it.trim('"')}" } ?: ""}")
            }
            val obj = json.parseToJsonElement(text).jsonObjectOrNull()
                ?: error("malformed auth response")
            val access = obj["access_token"]?.toString()?.trim('"')
                ?: error("no access_token (email confirmation may be pending)")
            CloudSession(
                accessToken = access,
                refreshToken = obj["refresh_token"]?.toString()?.trim('"') ?: "",
                userId = obj["user"]?.jsonObjectOrNull()?.get("id")?.toString()?.trim('"')
                    ?: obj["id"]?.toString()?.trim('"') ?: "",
                email = email,
            )
        }
    }

    private fun jsonStr(v: String): String = "\"" + v
        .replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    private fun kotlinx.serialization.json.JsonElement.jsonObjectOrNull(): kotlinx.serialization.json.JsonObject? =
        this as? kotlinx.serialization.json.JsonObject

    private object Keys {
        val access = stringPreferencesKey("cloud_access")
        val refresh = stringPreferencesKey("cloud_refresh")
        val userId = stringPreferencesKey("cloud_user_id")
        val email = stringPreferencesKey("cloud_email")
    }
}
