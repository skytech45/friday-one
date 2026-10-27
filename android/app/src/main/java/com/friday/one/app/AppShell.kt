package com.friday.one.app

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import com.friday.one.data.*
import com.friday.one.feature.home.DashboardView
import com.friday.one.feature.pairing.ServerPairingScreen
import com.friday.one.feature.security.SecurityView
import com.friday.one.feature.sessions.ChatView
import com.friday.one.ui.theme.*
import kotlinx.coroutines.launch

@Composable
internal fun AppDashboardShell(
    session: CloudSession,
    onSignedOut: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var servers by remember { mutableStateOf<List<CloudServer>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var activeChatServer by remember { mutableStateOf<CloudServer?>(null) }
    var securityOpen by remember { mutableStateOf(false) }
    var pairingOpen by remember { mutableStateOf(false) }
    var gatewayUrl by remember { mutableStateOf<String?>(com.friday.one.BuildConfig.GATEWAY_URL.ifBlank { null }) }
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
