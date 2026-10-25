package com.friday.one.security

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM tests for the pinning decisions (F-15). The pin VALUES themselves need a
 * live TLS handshake to verify — that is an instrumented/integration concern —
 * but the loopback exemption and host extraction are pure logic and the exact
 * place a careless refactor would silently disable pinning.
 */
class CertificatePinningTest {

    @Test
    fun `loopback hosts are recognised`() {
        assertTrue(CertificatePinning.isLoopback("127.0.0.1"))
        assertTrue(CertificatePinning.isLoopback("localhost"))
        assertTrue(CertificatePinning.isLoopback("::1"))
        assertTrue(CertificatePinning.isLoopback("[::1]")) // bracketed IPv6
        assertTrue(CertificatePinning.isLoopback("LOCALHOST")) // case-insensitive
        assertTrue(CertificatePinning.isLoopback("LocalHost"))
    }

    @Test
    fun `non-loopback hosts are not exempt`() {
        assertFalse(CertificatePinning.isLoopback("friday.knistudio.in"))
        assertFalse(CertificatePinning.isLoopback("example.trycloudflare.com"))
        assertFalse(CertificatePinning.isLoopback("10.0.0.1"))
        // A host that merely CONTAINS a loopback string is not loopback.
        assertFalse(CertificatePinning.isLoopback("127.0.0.1.evil.example"))
    }

    @Test
    fun `host extraction handles scheme, port, path and query`() {
        assertEquals(
            "friday.knistudio.in",
            CertificatePinning.extractHost("https://friday.knistudio.in/api"),
        )
        assertEquals(
            "friday.knistudio.in",
            CertificatePinning.extractHost("https://friday.knistudio.in:8443/api"),
        )
        assertEquals(
            "example.trycloudflare.com",
            CertificatePinning.extractHost("https://example.trycloudflare.com/health?x=1"),
        )
        assertEquals(
            "127.0.0.1",
            CertificatePinning.extractHost("http://127.0.0.1:8787"),
        )
        assertEquals(
            "127.0.0.1",
            CertificatePinning.extractHost("127.0.0.1:8787"), // no scheme
        )
        assertNull(CertificatePinning.extractHost("https:///path-only"))
    }
}
