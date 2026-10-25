package com.friday.one.data

import android.content.Context
import android.net.Uri
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.friday.one.BuildConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * Supabase Auth for the cloud stack — BOTH methods (plan v2 §5):
 *  - email + password (login, register)
 *  - Google OAuth via PKCE through a Custom Tab, returning through the
 *    fridayone://auth-callback deep link (activates the moment the owner
 *    enables the Google provider in Supabase — see docs GOOGLE_OAUTH_SETUP)
 *
 * The publishable key is public by design; every authorization decision is
 * server-side. Google passwords are NEVER seen by this app.
 */
private val Context.cloudStore by preferencesDataStore(name = "friday_cloud")

@kotlinx.serialization.Serializable
data class CloudSession(
    val accessToken: String,
    val refreshToken: String,
    val userId: String,
    val email: String,
)

/** Register outcome: signed straight in, or waiting on email confirmation. */
sealed interface SignupOutcome {
    data class SignedIn(val session: CloudSession) : SignupOutcome
    data object NeedsEmailConfirmation : SignupOutcome
}

object AuthCallbacks {
    /** Deep-link results land here from MainActivity.onNewIntent. */
    val googleRedirect = MutableStateFlow<Uri?>(null)
}

class SupabaseAuth(private val context: Context) {
    private val json = Json { ignoreUnknownKeys = true }
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    // ---- session store -----------------------------------------------------
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

    suspend fun clear() = context.cloudStore.edit { it.clear() }

    // ---- email + password --------------------------------------------------
    suspend fun login(email: String, password: String): CloudSession =
        authCall("token?grant_type=password", email, password).also { save(it) }

    suspend fun register(email: String, password: String): SignupOutcome {
        val body = mapOf("email" to email, "password" to password).jsonBody()
        val req = Request.Builder()
            .url("${BuildConfig.SUPABASE_URL}/auth/v1/signup")
            .header("apikey", BuildConfig.SUPABASE_PUBLISHABLE_KEY)
            .post(body)
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            val obj = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()
            if (!resp.isSuccessful) {
                val msg = obj?.get("msg")?.toString()?.trim('"') ?: "registration failed (${resp.code})"
                error(msg)
            }
            val access = obj?.get("access_token")?.toString()?.trim('"')
            return if (access != null) {
                val s = sessionFrom(obj, access, email)
                save(s)
                SignupOutcome.SignedIn(s)
            } else {
                SignupOutcome.NeedsEmailConfirmation
            }
        }
    }

    // ---- Google OAuth (PKCE) ----------------------------------------------
    private var pkceVerifier: String = ""

    fun googleAuthorizeUrl(): String {
        val verifier = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(ByteArray(48) { SecureRandom().nextInt(256).toByte() })
        pkceVerifier = verifier
        val challenge = java.security.MessageDigest.getInstance("SHA-256")
            .digest(verifier.toByteArray())
            .let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
        return "${BuildConfig.SUPABASE_URL}/auth/v1/authorize" +
            "?provider=google" +
            "&redirect_to=fridayone://auth-callback" +
            "&code_challenge=$challenge" +
            "&code_challenge_method=s256"
    }

    /** Exchange the deep-link code for a session (PKCE verifier in memory). */
    suspend fun completeGoogle(code: String): CloudSession {
        val body = mapOf("auth_code" to code, "code_verifier" to pkceVerifier).jsonBody()
        val req = Request.Builder()
            .url("${BuildConfig.SUPABASE_URL}/auth/v1/token?grant_type=pkce")
            .header("apikey", BuildConfig.SUPABASE_PUBLISHABLE_KEY)
            .post(body)
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            val obj = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()
            if (!resp.isSuccessful) {
                error(obj?.get("msg")?.toString()?.trim('"') ?: "google sign-in failed (${resp.code})")
            }
            val access = obj?.get("access_token")?.toString()?.trim('"')
                ?: error("no session in google callback")
            val s = sessionFrom(obj, access, obj?.get("email")?.toString()?.trim('"') ?: "")
            save(s)
            return s
        }
    }

    // ---- helpers -----------------------------------------------------------
    private suspend fun authCall(path: String, email: String, password: String): CloudSession {
        val body = mapOf("email" to email, "password" to password).jsonBody()
        val req = Request.Builder()
            .url("${BuildConfig.SUPABASE_URL}/auth/v1/$path")
            .header("apikey", BuildConfig.SUPABASE_PUBLISHABLE_KEY)
            .post(body)
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            val obj = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()
            if (!resp.isSuccessful) {
                val msg = obj?.get("msg")?.toString()?.trim('"') ?: "auth failed (${resp.code})"
                error(msg)
            }
            val access = obj?.get("access_token")?.toString()?.trim('"')
                ?: error("no session (confirm your email?)")
            return sessionFrom(obj, access, email).also { save(it) }
        }
    }

    private fun sessionFrom(obj: JsonObject?, access: String, email: String): CloudSession {
        val user = obj?.get("user") as? JsonObject
        return CloudSession(
            accessToken = access,
            refreshToken = obj?.get("refresh_token")?.toString()?.trim('"') ?: "",
            userId = user?.get("id")?.toString()?.trim('"')
                ?: obj?.get("id")?.toString()?.trim('"') ?: "",
            email = email,
        )
    }

    private fun Map<String, String>.jsonBody() =
        entries.joinToString(",", prefix = "{", postfix = "}") { (k, v) ->
            "\"$k\":\"${v.replace("\\", "\\\\").replace("\"", "\\\"")}\""
        }.toRequestBody("application/json".toMediaType())

    private object Keys {
        val access = stringPreferencesKey("cloud_access")
        val refresh = stringPreferencesKey("cloud_refresh")
        val userId = stringPreferencesKey("cloud_user_id")
        val email = stringPreferencesKey("cloud_email")
    }
}
