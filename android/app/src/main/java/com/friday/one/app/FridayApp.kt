package com.friday.one.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.friday.one.core.designsystem.Dash
import com.friday.one.data.*
import com.friday.one.feature.auth.AuthScreen
import com.friday.one.ui.theme.*
import kotlinx.coroutines.launch

/**
 * FRIDAY One — Cloud UI Suite (v2.0 / PRD §6 / UI_UX_GUIDE §7-§9)
 *
 * Flow:
 * 1. Authentication (Login / Register with Google OAuth PKCE and email/password).
 * 2. Dedicated Server Pairing Screen (prominently surfaced after registration or via "Add Server")
 *    - Step 1: Install connector on cloud server.
 *    - Step 2: Run `fridayone` on terminal with one-time enrollment token.
 *    - Step 3: Choose "Scan Terminal QR Code" or "Pair with Key" (16-20 digit code).
 * 3. Server Management Dashboard (live health, metrics, agent launcher, policy editor).
 * 4. AI Agent Chat (live streaming deltas, cancellation, inline permission approvals).
 */
@Composable
fun FridayApp(auth: SupabaseAuth) {
    val scope = rememberCoroutineScope()
    var session by remember { mutableStateOf<CloudSession?>(null) }
    var checking by remember { mutableStateOf(true) }
    var googleError by remember { mutableStateOf<String?>(null) }

    // Google OAuth PKCE deep link: fridayone://auth-callback?code=...
    LaunchedEffect(Unit) {
        auth.current()?.let { session = it }
        checking = false
        AuthCallbacks.googleRedirect.collect { uri ->
            if (uri != null) {
                AuthCallbacks.googleRedirect.value = null
                val code = uri.getQueryParameter("code")
                val err = uri.getQueryParameter("error_description") ?: uri.getQueryParameter("error")
                when {
                    code != null -> scope.launch {
                        runCatching { auth.completeGoogle(code) }
                            .onSuccess { session = it }
                            .onFailure { googleError = it.message }
                    }
                    err != null -> googleError = err
                }
            }
        }
    }

    when {
        checking -> Box(Modifier.fillMaxSize().background(Dash.Bg), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = FridayBrandBlue)
        }
        session == null -> AuthScreen(
            auth = auth,
            onSignedIn = { s -> session = s },
            googleError = googleError,
        )
        else -> AppDashboardShell(
            auth = auth,
            session = session!!,
            onSignedOut = {
                scope.launch { auth.clear() }
                session = null
            },
        )
    }
}
