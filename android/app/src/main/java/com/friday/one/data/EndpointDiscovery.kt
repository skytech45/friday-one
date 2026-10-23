package com.friday.one.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Keeps the app pointed at the right backend.
 *
 * The backend is reached through a cloudflared quick tunnel, which gets a new
 * random hostname on every restart. A hostname baked into the APK therefore goes
 * stale, which used to mean "rebuild and reinstall to keep using the app".
 *
 * Instead the tunnel URL is published to a small public gist (public base URL
 * only - it carries no token, so publishing it is safe) and the app reads it
 * back. On every launch, and again if a request fails to connect, the app asks
 * the gist where the server is and repoints itself.
 *
 * This is deliberately best-effort: no network, an empty gist or malformed JSON
 * must never block the app, so every failure path returns null and the caller
 * keeps whatever URL it already had.
 */
class EndpointDiscovery(private val session: SessionStore) {

    @Serializable
    private data class Endpoint(
        val base_url: String,
        val updated: String? = null,
        val app: String? = null,
    )

    private val json = Json { ignoreUnknownKeys = true }

    // Short timeouts: this runs on the startup path, so a slow DNS lookup or a
    // hanging connection must fail fast rather than delay the login screen.
    private val client = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(6, TimeUnit.SECONDS)
        .build()

    /**
     * Ask the discovery document for the current base URL.
     *
     * @return the new base URL if it differs from what is stored AND answers,
     *         else null (caller keeps its existing URL).
     */
    suspend fun refresh(): String? {
        val discovered = runCatching {
            val req = Request.Builder().url(DISCOVERY_URL).build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                resp.body?.string()
            }
        }.getOrNull() ?: return null

        val endpoint = runCatching { json.decodeFromString<Endpoint>(discovered) }.getOrNull()
            ?: return null

        val url = endpoint.base_url.trim().trimEnd('/')
        // Require https: a discovery document that told the app to talk plaintext
        // would silently downgrade every credential the app sends.
        if (!url.startsWith("https://")) return null

        val current = session.baseUrlNow()?.trim()?.trimEnd('/')
        if (url == current) return null

        // Only switch once the new host has actually answered. Trusting the
        // document alone would let a stale or half-published entry point the app
        // at a dead host with no way back except clearing app data.
        if (!isReachable(url)) return null

        session.setBaseUrl(url)
        return url
    }

    /**
     * Quick liveness check used before trusting a URL we are about to switch to,
     * so a stale or malformed discovery entry cannot strand the app on a dead host.
     */
    suspend fun isReachable(baseUrl: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val req = Request.Builder().url("$baseUrl/health").build()
            client.newCall(req).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    companion object {
        /**
         * Public gist holding {"base_url": "...", "updated": "..."}.
         * Contains no credentials - see scripts/publish-endpoint.sh.
         */
        const val DISCOVERY_URL =
            "https://gist.githubusercontent.com/skytech45/" +
                "462b9df17f30fd7029e4ead519103f20/raw/endpoint.json"
    }
}
