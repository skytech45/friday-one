package com.friday.one.feature.cloud

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
import com.friday.one.feature.home.DashboardView
import com.friday.one.feature.pairing.ServerPairingScreen
import com.friday.one.feature.security.SecurityView
import com.friday.one.feature.sessions.ChatView
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
fun CloudScreen(auth: SupabaseAuth) {
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

// ============================================================================
// 2. MAIN APPLICATION SHELL & DASHBOARD
// ============================================================================
@Composable
private fun AppDashboardShell(
    auth: SupabaseAuth,
    session: CloudSession,
    onSignedOut: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var servers by remember { mutableStateOf<List<CloudServer>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var activeChatServer by remember { mutableStateOf<CloudServer?>(null) }
    var securityOpen by remember { mutableStateOf(false) }
    var pairingOpen by remember { mutableStateOf(false) }
    var gatewayUrl by remember { mutableStateOf<String?>(com.friday.one.BuildConfig.GATEWAY_URL) }
    val client = remember { ControlPlaneClient() }

    suspend fun reloadServers() {
        try {
            servers = client.listServers(session.accessToken)
            loadError = null
            // If user has 0 servers after load, automatically guide them to the pairing flow
            if (servers != null && servers!!.isEmpty()) {
                pairingOpen = true
            }
        } catch (e: Exception) {
            if (e.message?.contains("401") == true) onSignedOut()
            else loadError = e.message
        }
    }

    LaunchedEffect(session.accessToken) {
        reloadServers()
        client.gatewayUrl(session.accessToken)?.let { gatewayUrl = it }
    }

    when {
        // Active Chat View
        activeChatServer != null -> {
            gatewayUrl?.let { gw ->
                ChatView(
                    session = session,
                    server = activeChatServer!!,
                    gatewayUrl = gw,
                    onBack = {
                        activeChatServer = null
                        scope.launch { reloadServers() }
                    },
                )
            }
        }
        // Security & Audit View
        securityOpen -> {
            SecurityView(
                accessToken = session.accessToken,
                servers = servers ?: emptyList(),
                onBack = {
                    securityOpen = false
                    scope.launch { reloadServers() }
                },
            )
        }
        // Dedicated Pairing Screen
        pairingOpen -> {
            ServerPairingScreen(
                accessToken = session.accessToken,
                existingCount = servers?.size ?: 0,
                onPairingComplete = {
                    pairingOpen = false
                    scope.launch { reloadServers() }
                },
                onCancel = {
                    pairingOpen = false
                    scope.launch { reloadServers() }
                },
            )
        }
        // Home Servers Dashboard
        else -> {
            DashboardView(
                session = session,
                servers = servers,
                loadError = loadError,
                onAddServer = { pairingOpen = true },
                onOpenChat = { srv -> activeChatServer = srv },
                onOpenSecurity = { securityOpen = true },
                onReload = { scope.launch { reloadServers() } },
                onSignedOut = onSignedOut,
            )
        }
    }
}
