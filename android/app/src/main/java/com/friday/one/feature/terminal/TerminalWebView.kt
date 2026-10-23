package com.friday.one.feature.terminal

import android.annotation.SuppressLint
import android.graphics.Color
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/**
 * Compose wrapper hosting a WebView that loads the local xterm.js terminal page.
 *
 * Auth tradeoff: WebSocket handshakes from a WebView cannot carry custom HTTP
 * headers reliably across Android versions. The backend already accepts the JWT
 * as a `token` query parameter on `/ws/terminal` (see server/src/routes/terminal.ts),
 * so we pass it there instead of an Authorization header. The token is short-lived
 * (15 min) which limits exposure.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TerminalWebView(
    modifier: Modifier = Modifier,
    wsUrl: String,
    onWebViewCreated: (WebView) -> Unit = {},
) {
    var webViewRef: WebView? = null

    DisposableEffect(wsUrl) {
        onDispose {
            // Destroy the WebView when leaving the composition so the socket closes
            webViewRef?.apply {
                stopLoading()
                loadUrl("about:blank")
                (parent as? ViewGroup)?.removeView(this)
                destroy()
            }
            webViewRef = null
        }
    }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            WebView(ctx).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                setBackgroundColor(Color.parseColor("#0d1117"))

                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.mediaPlaybackRequiresUserGesture = false

                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView?,
                        request: WebResourceRequest?,
                    ): Boolean = false

                    override fun onPageFinished(view: WebView, url: String?) {
                        // Kept as a safety net only. The page already auto-connects
                        // on load, so injecting afterwards races with that first
                        // attempt: if the socket opened with no URL it shows
                        // "No WebSocket URL configured" and gives up. Passing the
                        // URL as a query param (below) means the very first
                        // connect() already has it, and this merely re-triggers
                        // if the page somehow started without one.
                        view.evaluateJavascript(
                            "(function(){ if (typeof connect === 'function' && !window.__WS_CONNECTED__) connect(); })();",
                            null,
                        )
                    }
                }

                // Load from local assets - no network required for the renderer
                // itself. The WS URL travels as a query param so it is available
                // to the page's initial connect() call rather than injected after
                // the fact. URLEncoder is paired with URLSearchParams on the JS
                // side, so the nested ?kind=&token= survives the round trip.
                val wsParam = java.net.URLEncoder.encode(wsUrl, "UTF-8")
                loadUrl("file:///android_asset/terminal/index.html?ws=$wsParam")
                webViewRef = this
                onWebViewCreated(this)
            }
        },
    )
}
