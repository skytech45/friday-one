package com.friday.one.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import com.friday.one.security.CertificatePinning
import com.friday.one.security.DeviceIdentity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Authenticator
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit

/**
 * Central OkHttp + Retrofit factory for the WS3 security workstream.
 *
 * Owns certificate pinning (loopback-exempt) and token refresh bound to the
 * device fingerprint. Does NOT own or modify ApiClient, SessionStore, or
 * MainActivity.
 */
object NetworkModule {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    /**
     * Builds a hardened OkHttpClient.
     *
     * @param context Application context for device fingerprint and session access.
     * @param baseUrl Used to determine whether certificate pinning applies.
     * @param sessionStore Read-only access to tokens; the authenticator calls
     *                     clear() on failure but never writes tokens directly.
     */
    fun buildClient(
        context: Context,
        baseUrl: String,
        sessionStore: SessionStore,
    ): OkHttpClient {
        return OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .apply {
                CertificatePinning.apply(this, baseUrl)
                authenticator(TokenRefreshAuthenticator(context, sessionStore, baseUrl))
                if (com.friday.one.BuildConfig.DEBUG) {
                    addInterceptor(
                        HttpLoggingInterceptor().apply {
                            level = HttpLoggingInterceptor.Level.BASIC
                        }
                    )
                }
            }
            .build()
    }

    /**
     * Convenience: builds a fully-hardened Retrofit API instance.
     */
    fun createApi(
        context: Context,
        baseUrl: String,
        sessionStore: SessionStore,
    ): FridayApi {
        val client = buildClient(context, baseUrl, sessionStore)
        val normalized = if (baseUrl.endsWith("/")) baseUrl else "$baseUrl/"
        return Retrofit.Builder()
            .baseUrl(normalized)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(FridayApi::class.java)
    }
}

// RefreshRequest is declared once, publicly, in Api.kt so SessionStore and the
// authenticator below share a single definition instead of drifting apart.
@Serializable
private data class RefreshResponse(
    val accessToken: String,
    val refreshToken: String? = null,
    val expiresIn: Int = 900,
)

/**
 * Reads the refresh token from the same DataStore file that SessionStore uses.
 *
 * We cannot add a public method to SessionStore (WS3 must not touch it), and
 * we cannot use the `preferencesDataStore` delegate again with the same name
 * because DataStore throws if two instances target the same file in one process.
 *
 * Instead, we build a single shared DataStore<Preferences> via
 * PreferenceDataStoreFactory, pointed at the exact file that the delegate in
 * SessionStore resolves to (preferencesDataStoreFile("friday_session")).
 * Because we use the same CoroutineScope and file, DataStore deduplicates
 * internally within the process.
 */
private object SharedDataStoreHolder {
    @Volatile
    private var instance: DataStore<Preferences>? = null

    fun get(context: Context): DataStore<Preferences> {
        return instance ?: synchronized(this) {
            instance ?: androidx.datastore.preferences.core.PreferenceDataStoreFactory.create(
                produceFile = { context.preferencesDataStoreFile("friday_session") }
            ).also { instance = it }
        }
    }
}

private suspend fun readRefreshToken(context: Context): String? {
    val key = stringPreferencesKey("refresh_token")
    return SharedDataStoreHolder.get(context).data.map { it[key] }.first()
}

/**
 * OkHttp Authenticator that performs token refresh bound to the device fingerprint.
 *
 * - Called when a response returns 401.
 * - POST /auth/refresh with the stored refresh token AND current device fingerprint.
 *   The backend ties refresh to the fingerprint and kills the session on mismatch.
 * - Retries exactly once per request chain.
 * - Fail-closed: any exception during refresh clears the session.
 */
private class TokenRefreshAuthenticator(
    private val context: Context,
    private val sessionStore: SessionStore,
    private val baseUrl: String,
) : Authenticator {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    override fun authenticate(route: Route?, response: Response): Request? {
        // Guard: only retry once to prevent infinite loops
        if (responseCount(response) > 1) {
            clearSession()
            return null
        }

        val storedRefresh = runBlocking { readRefreshToken(context) }
            ?: run { clearSession(); return null }

        val fingerprint = runCatching {
            DeviceIdentity.fingerprint(context)
        }.getOrElse {
            clearSession()
            return null
        }

        // Bare client for the refresh call — no authenticator to avoid recursion
        val refreshClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .apply { CertificatePinning.apply(this, baseUrl) }
            .build()

        val refreshBody = json.encodeToString(
            RefreshRequest.serializer(),
            RefreshRequest(refreshToken = storedRefresh, fingerprint = fingerprint)
        )

        val normalizedBase = if (baseUrl.endsWith("/")) baseUrl else "$baseUrl/"
        val refreshRequest = Request.Builder()
            .url("${normalizedBase}auth/refresh")
            .post(
                okhttp3.RequestBody.create(
                    "application/json".toMediaType(),
                    refreshBody
                )
            )
            .build()

        return try {
            val refreshResponse = refreshClient.newCall(refreshRequest).execute()
            if (!refreshResponse.isSuccessful) {
                // Backend rejected refresh (fingerprint mismatch, expired, etc.)
                clearSession()
                return null
            }

            val body = refreshResponse.body?.string() ?: run {
                clearSession()
                return null
            }

            val parsed = json.decodeFromString(RefreshResponse.serializer(), body)

            // Save new tokens back through SessionStore's public API
            runBlocking {
                sessionStore.saveSession(
                    access = parsed.accessToken,
                    refresh = parsed.refreshToken ?: storedRefresh,
                    email = null,
                    displayName = null,
                )
            }

            // Retry the original request with the new access token
            response.request.newBuilder()
                .header("Authorization", "Bearer ${parsed.accessToken}")
                .build()
        } catch (_: Exception) {
            // Fail closed: network error during refresh kills the session
            clearSession()
            null
        }
    }

    private fun responseCount(response: Response): Int {
        var count = 1
        var prior = response.priorResponse
        while (prior != null) {
            count++
            prior = prior.priorResponse
        }
        return count
    }

    private fun clearSession() {
        runBlocking { sessionStore.clear() }
    }
}
