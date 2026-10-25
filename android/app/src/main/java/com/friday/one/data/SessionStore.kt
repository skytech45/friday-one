package com.friday.one.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.friday.one.security.DeviceIdentity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "friday_session")

/**
 * True if the JWT is expired or expires within [skewSeconds].
 *
 * Only the `exp` claim is read, and the signature is deliberately NOT
 * verified: this is a local optimisation to avoid a pointless round-trip,
 * never a security decision. The server verifies every token it receives.
 * Anything unparseable is treated as expired, which fails safe - a refresh
 * costs one request, whereas trusting an unreadable token costs a dead UI.
 *
 * Top-level (not a method) so JVM unit tests can exercise the boundaries
 * without an Android Context; java.util.Base64 instead of android.util.Base64
 * for the same reason (URL-safe, no padding — identical alphabet for JWTs).
 */
internal fun isJwtExpiring(jwt: String, skewSeconds: Long, nowSeconds: Long): Boolean {
    return runCatching {
        val parts = jwt.split('.')
        if (parts.size < 2) return true
        val payload = String(
            java.util.Base64.getUrlDecoder().decode(parts[1]),
            Charsets.UTF_8,
        )
        val exp = Regex("\"exp\"\\s*:\\s*(\\d+)").find(payload)
            ?.groupValues?.get(1)?.toLongOrNull()
            ?: return true
        exp - nowSeconds <= skewSeconds
    }.getOrDefault(true)
}

/**
 * Session state on disk.
 *
 * Tokens are the only sensitive thing here. They live in DataStore (app-private),
 * are excluded from cloud backup by data_extraction_rules.xml, and are cleared
 * on logout. The device fingerprint is NOT stored - it is recomputed from the
 * keystore each launch so a tampered preference cannot impersonate another
 * device.
 *
 * Access tokens live 15 minutes (see issueSession on the server). Nothing used
 * the stored refresh token, so every long-lived screen silently died after a
 * quarter of an hour: telemetry stopped updating and the terminal socket could
 * no longer re-authenticate. [validToken] is the fix - call it instead of
 * [accessToken] anywhere that runs for longer than a login.
 */
class SessionStore(private val context: Context) {

    private object Keys {
        val access = stringPreferencesKey("access_token")
        val refresh = stringPreferencesKey("refresh_token")
        val email = stringPreferencesKey("email")
        val displayName = stringPreferencesKey("display_name")
        val baseUrl = stringPreferencesKey("base_url")
    }

    val baseUrl: Flow<String> = context.dataStore.data.map { it[Keys.baseUrl] ?: com.friday.one.BuildConfig.BASE_URL }
    val email: Flow<String?> = context.dataStore.data.map { it[Keys.email] }
    val isLoggedIn: Flow<Boolean> = context.dataStore.data.map { !it[Keys.access].isNullOrBlank() }

    suspend fun saveSession(
        access: String,
        refresh: String,
        email: String?,
        displayName: String?,
    ) {
        context.dataStore.edit { prefs ->
            prefs[Keys.access] = access
            prefs[Keys.refresh] = refresh
            email?.let { prefs[Keys.email] = it }
            displayName?.let { prefs[Keys.displayName] = it }
        }
    }

    suspend fun setBaseUrl(url: String) {
        context.dataStore.edit { it[Keys.baseUrl] = url.trim().trimEnd('/') }
    }

    /** One-shot read of the persisted base URL, for callers that are not collecting. */
    suspend fun baseUrlNow(): String? = context.dataStore.data.first()[Keys.baseUrl]

    suspend fun accessToken(): String? = context.dataStore.data.first()[Keys.access]

    /**
     * An access token guaranteed to be usable, refreshing it if it is about to
     * expire.
     *
     * Call this instead of [accessToken] in anything that outlives a login:
     * the telemetry poller, the terminal socket, file transfers. Returns null
     * only when there is genuinely no session (or the refresh was rejected, in
     * which case the session has been cleared and the UI should send the user
     * back to login).
     *
     * @param baseUrl the server to refresh against - it is not read from
     *   DataStore here because callers already hold it and may have just
     *   switched hosts via discovery.
     */
    suspend fun validToken(baseUrl: String): String? {
        val prefs = context.dataStore.data.first()
        val access = prefs[Keys.access] ?: return null

        // 60s of slack so a token cannot expire between this check and the
        // request landing.
        if (!isExpiring(access, skewSeconds = 60)) return access

        val refresh = prefs[Keys.refresh]
        if (refresh.isNullOrBlank()) {
            clear()
            return null
        }

        return runCatching {
            val resp = ApiClient.create(baseUrl).refresh(
                RefreshRequest(
                    refreshToken = refresh,
                    // Must match the fingerprint the session was issued against;
                    // the server kills the session on a mismatch by design.
                    fingerprint = DeviceIdentity.fingerprint(context),
                ),
            )
            saveSession(resp.accessToken, resp.refreshToken, prefs[Keys.email], prefs[Keys.displayName])
            resp.accessToken
        }.getOrElse {
            // A rejected refresh means the session is dead (expired, revoked, or
            // replayed from another device). Clear it so the UI shows login
            // rather than retrying against a token that can never work.
            clear()
            null
        }
    }

    /**
     * True if the JWT is expired or expires within [skewSeconds].
     *
     * Only the `exp` claim is read, and the signature is deliberately NOT
     * verified: this is a local optimisation to avoid a pointless round-trip,
     * never a security decision. The server verifies every token it receives.
     * Anything unparseable is treated as expired, which fails safe - a refresh
     * costs one request, whereas trusting an unreadable token costs a dead UI.
     */
    private fun isExpiring(jwt: String, skewSeconds: Long): Boolean {
        return isJwtExpiring(jwt, skewSeconds, System.currentTimeMillis() / 1000)
    }

    suspend fun clear() {
        context.dataStore.edit { prefs ->
            prefs.remove(Keys.access)
            prefs.remove(Keys.refresh)
            prefs.remove(Keys.displayName)
        }
    }
}
