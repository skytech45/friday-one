package com.friday.one.feature.terminal

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * These two functions build JavaScript that is injected into a WebView that
 * renders UNTRUSTED terminal output. A broken escape here is an HTML/JS
 * injection primitive, so the escaping contract is pinned by tests (F-15).
 */
class TerminalUrlTest {

    @Test
    fun `jsString escapes backslashes first`() {
        // A trailing backslash must not escape the closing quote of the literal.
        assertEquals("'a\\\\'", jsString("a\\"))
    }

    @Test
    fun `jsString escapes single quotes`() {
        assertEquals("'\\''", jsString("'"))
        assertEquals("'a\\'b'", jsString("a'b"))
    }

    @Test
    fun `jsString escapes newlines`() {
        assertEquals("'a\\nb'", jsString("a\nb"))
    }

    @Test
    fun `jsString leaves no unescaped quotes inside the literal`() {
        // The injection shape an attacker reaches for: break out of the literal.
        val attack = "x\\'; alert(1); '"
        val out = jsString(attack)
        // The literal must open and close with exactly one quote each, and no
        // unescaped quote may appear between them — otherwise the string broke
        // out of its literal and the rest is executable JS.
        org.junit.Assert.assertTrue(out.startsWith("'"))
        org.junit.Assert.assertTrue(out.endsWith("'"))
        val inner = out.substring(1, out.length - 1)
        var i = 0
        while (i < inner.length) {
            if (inner[i] == '\\') { i += 2; continue } // skip escaped char
            org.junit.Assert.assertNotEquals('\'', inner[i])
            i++
        }
    }

    @Test
    fun `wsUrlFor upgrades https to wss and strips trailing slash`() {
        assertEquals(
            "wss://friday.knistudio.in/ws/terminal?kind=shell&token=T",
            wsUrlFor("https://friday.knistudio.in/", "shell", "T"),
        )
    }

    @Test
    fun `wsUrlFor upgrades http to ws`() {
        assertEquals(
            "ws://127.0.0.1:8787/ws/terminal?kind=hermes&token=T",
            wsUrlFor("http://127.0.0.1:8787", "hermes", "T"),
        )
    }
}
