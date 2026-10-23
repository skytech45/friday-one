package com.friday.one.security

import okhttp3.CertificatePinner
import okhttp3.OkHttpClient

/**
 * Certificate pinning for the Cloudflare tunnel host.
 *
 * Pinning is applied ONLY when the base URL resolves to a non-loopback host.
 * Loopback (127.0.0.1 / localhost) is always exempt so local development against
 * the console does not break.
 *
 * ## Rotation path
 * 1. Generate the new leaf + intermediate from Cloudflare.
 * 2. Run: openssl s_client -servername <host> -connect <host>:443 | \
 *         openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | \
 *         openssl dgst -sha256 -binary | openssl enc -base64
 *    to get the new sha256 pin.
 * 3. Add the new pin to [TUNNEL_PINS] below BEFORE removing the old one, so both
 *    are valid during the transition window.
 * 4. Ship the app update. Once the fleet has updated, remove the old pin.
 */
object CertificatePinning {

    /**
     * SHA-256 pins for the Cloudflare tunnel certificate chain.
     * Replace these placeholders with real pins once the tunnel domain is stable.
     * Format: "sha256/<base64-encoded-spki-hash>"
     */
    private val TUNNEL_PINS: List<String> = listOf(
        // TODO(ws3): replace with actual pins from the production tunnel cert
    )

    private val LOOPBACK_HOSTS = setOf("127.0.0.1", "localhost", "::1")

    fun isLoopback(host: String): Boolean {
        val stripped = host.removePrefix("[").removeSuffix("]")
        return stripped.lowercase() in LOOPBACK_HOSTS
    }

    /**
     * Applies certificate pinning to the builder when the target host is not
     * loopback and pins are configured. If no pins exist yet (dev), this is a
     * no-op but the structure is in place for production.
     */
    fun apply(builder: OkHttpClient.Builder, baseUrl: String) {
        val host = extractHost(baseUrl) ?: return

        // Never pin loopback — local dev uses plain HTTP or self-signed certs
        if (isLoopback(host)) return

        // If no pins are configured yet, skip silently (dev environment)
        if (TUNNEL_PINS.isEmpty()) return

        val pinnerBuilder = CertificatePinner.Builder()
        for (pin in TUNNEL_PINS) {
            pinnerBuilder.add(host, pin)
        }
        builder.certificatePinner(pinnerBuilder.build())
    }

    private fun extractHost(url: String): String? {
        val withoutScheme = url.substringAfter("://", url)
        val hostPort = withoutScheme.substringBefore("/").substringBefore("?")
        val host = hostPort.substringBeforeLast(":")
        return host.ifBlank { null }
    }
}
