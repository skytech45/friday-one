package com.friday.one.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * Boundary tests for the local JWT-expiry check (F-15). This function gates
 * whether the app silently refreshes before a request; the boundaries matter
 * because a token that "never expires" locally means every long-lived screen
 * dies after 15 minutes, and a token that always looks expired burns refresh
 * calls. Signature is deliberately not verified here (server's job) — see the
 * doc comment on [isJwtExpiring].
 */
class JwtExpiryTest {

    private fun jwtWithExp(expSeconds: Long): String {
        val header = Base64.getUrlEncoder().withoutPadding().encodeToString("""{"alg":"HS256"}""".toByteArray())
        val payload = Base64.getUrlEncoder().withoutPadding()
            .encodeToString("""{"sub":"u","exp":$expSeconds}""".toByteArray())
        return "$header.$payload.sig"
    }

    private val NOW = 1_700_000_000L

    @Test
    fun `token expired well in the past is expiring`() {
        assertTrue(isJwtExpiring(jwtWithExp(NOW - 3600), skewSeconds = 60, nowSeconds = NOW))
    }

    @Test
    fun `token exactly at expiry boundary is expiring (le 60s skew)`() {
        // exp - now == skew -> considered expiring (the refresh happens BEFORE
        // the token can die in flight).
        assertTrue(isJwtExpiring(jwtWithExp(NOW + 60), skewSeconds = 60, nowSeconds = NOW))
    }

    @Test
    fun `token inside the skew window is expiring`() {
        assertTrue(isJwtExpiring(jwtWithExp(NOW + 30), skewSeconds = 60, nowSeconds = NOW))
    }

    @Test
    fun `token just outside the skew window is NOT expiring`() {
        // exp - now == skew + 1 -> one second of real validity left beyond slack.
        assertFalse(isJwtExpiring(jwtWithExp(NOW + 61), skewSeconds = 60, nowSeconds = NOW))
    }

    @Test
    fun `token far in the future is not expiring`() {
        assertFalse(isJwtExpiring(jwtWithExp(NOW + 900), skewSeconds = 60, nowSeconds = NOW))
    }

    @Test
    fun `payload without exp is treated as expiring (fails safe)`() {
        val header = Base64.getUrlEncoder().withoutPadding().encodeToString("""{"alg":"HS256"}""".toByteArray())
        val payload = Base64.getUrlEncoder().withoutPadding().encodeToString("""{"sub":"u"}""".toByteArray())
        assertTrue(isJwtExpiring("$header.$payload.sig", skewSeconds = 60, nowSeconds = NOW))
    }

    @Test
    fun `garbage token is treated as expiring (fails safe)`() {
        assertTrue(isJwtExpiring("not-a-jwt", skewSeconds = 60, nowSeconds = NOW))
        assertTrue(isJwtExpiring("", skewSeconds = 60, nowSeconds = NOW))
        assertTrue(isJwtExpiring("###.%%%", skewSeconds = 60, nowSeconds = NOW))
    }
}
