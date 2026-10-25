package com.friday.one.feature.terminal

import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.one.data.SessionStore

/**
 * Drop-in replacement for the old crude TerminalScreen.
 * Same call shape so MainActivity needs no refactoring beyond the import.
 */
@Composable
fun TerminalScreen(
    session: SessionStore,
    baseUrl: String,
    kind: String,
    title: String,
) {
    var token by remember { mutableStateOf<String?>(null) }
    var webView by remember { mutableStateOf<WebView?>(null) }

    // Start with a usable token, then keep it fresh. A terminal session outlives
    // the 15-minute access token, and when the socket drops the page reconnects
    // with whatever URL it holds - so without this the terminal worked once and
    // then failed permanently with 4401 unauthorized.
    LaunchedEffect(baseUrl) {
        while (true) {
            val fresh = session.validToken(baseUrl)
            if (fresh != null && fresh != token) {
                val previous = token
                token = fresh
                // If this is a rotation rather than the first token, push the new
                // URL into the live page and let it reconnect, instead of
                // recreating the WebView (which would also lose scrollback).
                if (previous != null) {
                    webView?.evaluateJavascript(
                        "(function(){ window.__WS_URL__ = ${jsString(wsUrlFor(baseUrl, kind, fresh))};" +
                            " if (typeof connect === 'function') connect(); })();",
                        null,
                    )
                }
            }
            kotlinx.coroutines.delay(60_000)
        }
    }

    Column(Modifier.fillMaxSize().background(Color(0xFF0d1117))) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            token?.let { t ->
                // key() on the URL: a token rotation rebuilds the WebView so the
                // page's initial connect() always has a valid token. The
                // in-page injection above handles the no-reload path; this is
                // the belt-and-braces case where the page was destroyed.
                TerminalWebView(
                    modifier = Modifier.fillMaxSize(),
                    wsUrl = wsUrlFor(baseUrl, kind, t),
                    onWebViewCreated = { wv -> webView = wv },
                )
            }
        }
        KeyboardBar(webView)
    }
}

/** https -> wss, http -> ws. Token rides in the query string (see terminal.ts). */
internal fun wsUrlFor(baseUrl: String, kind: String, token: String): String {
    val ws = baseUrl.trimEnd('/')
        .replaceFirst("https://", "wss://")
        .replaceFirst("http://", "ws://")
    return "$ws/ws/terminal?kind=$kind&token=$token"
}

/** Escape an arbitrary string for embedding in a single-quoted JS literal. */
internal fun jsString(value: String): String =
    "'" + value.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n") + "'"

private fun sendToTerm(webView: WebView?, data: String) {
    if (webView == null) return
    val escaped = data
        .replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    webView.evaluateJavascript("window.termSend('$escaped');", null)
}

@Composable
private fun KeyboardBar(webView: WebView?) {
    val btnColor = Color(0xFF1c2026)
    val textColor = Color(0xFFe6edf3)
    val scrollState = rememberScrollState()

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(scrollState)
            .background(Color(0xFF0d1117))
            .padding(horizontal = 4.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        KeyBtn("Esc", btnColor, textColor) { sendToTerm(webView, "\u001b") }
        KeyBtn("Tab", btnColor, textColor) { sendToTerm(webView, "\t") }
        KeyBtn("Ctrl-C", btnColor, textColor) { sendToTerm(webView, "\u0003") }
        KeyBtn("\u2190", btnColor, textColor) { sendToTerm(webView, "\u001b[D") }
        KeyBtn("\u2193", btnColor, textColor) { sendToTerm(webView, "\u001b[B") }
        KeyBtn("\u2191", btnColor, textColor) { sendToTerm(webView, "\u001b[A") }
        KeyBtn("\u2192", btnColor, textColor) { sendToTerm(webView, "\u001b[C") }
    }
}

@Composable
private fun KeyBtn(
    label: String,
    bg: Color,
    fg: Color,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        colors = ButtonDefaults.buttonColors(
            containerColor = bg,
            contentColor = fg,
        ),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
        modifier = Modifier.height(36.dp),
    ) {
        Text(label, fontSize = 12.sp, color = fg)
    }
}
