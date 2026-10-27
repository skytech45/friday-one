package com.friday.one.feature.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.one.core.designsystem.Dash
import com.friday.one.core.designsystem.components.MetricCard
import com.friday.one.core.designsystem.components.ServerCard
import com.friday.one.data.*
import com.friday.one.ui.theme.*

@Composable
internal fun DashboardView(
    session: CloudSession,
    servers: List<CloudServer>?,
    loadError: String?,
    onAddServer: () -> Unit,
    onOpenChat: (CloudServer) -> Unit,
    onOpenSecurity: () -> Unit,
    onReload: () -> Unit,
    onSignedOut: () -> Unit,
) {
    val onlineCount = servers?.count { it.online } ?: 0
    val totalCount = servers?.size ?: 0
    val staleCount = totalCount - onlineCount

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Dash.Bg)
            .padding(horizontal = 16.dp, vertical = 20.dp),
    ) {
        // App Top Bar
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    "FRIDAY One",
                    color = Dash.Text,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = (-0.3).sp,
                )
                Text(session.email, color = Dash.Dim, fontSize = 12.sp)
            }
            IconButton(onClick = onOpenSecurity) {
                Icon(Icons.Outlined.Security, "Security", tint = FridayBrandBlue)
            }
            IconButton(onClick = onReload) {
                Icon(Icons.Outlined.Refresh, "Refresh", tint = Dash.Dim)
            }
            TextButton(onClick = onSignedOut) {
                Text("Sign out", color = FridayStatusCrit, fontSize = 13.sp)
            }
        }

        Spacer(Modifier.height(16.dp))

        // Metric Summary Cards
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            MetricCard(title = "SERVERS", value = "$totalCount", color = Dash.Text, modifier = Modifier.weight(1f))
            MetricCard(title = "ONLINE", value = "$onlineCount", color = FridayStatusOk, modifier = Modifier.weight(1f))
            MetricCard(title = "OFFLINE", value = "$staleCount", color = if (staleCount > 0) FridayStatusWarn else Dash.Dim, modifier = Modifier.weight(1f))
        }

        Spacer(Modifier.height(20.dp))

        // Section Title & Add Server Action
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Your Servers",
                color = Dash.Text,
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            FilledTonalButton(
                onClick = onAddServer,
                colors = ButtonDefaults.filledTonalButtonColors(containerColor = FridayBrandBlue.copy(alpha = 0.15f)),
                shape = RoundedCornerShape(12.dp),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
            ) {
                Icon(Icons.Outlined.Add, null, tint = FridayBrandBlue, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Add Server", color = FridayBrandBlue, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
        }

        Spacer(Modifier.height(10.dp))
        loadError?.let { Text(it, color = FridayStatusCrit, fontSize = 12.sp, modifier = Modifier.padding(bottom = 8.dp)) }

        when {
            servers == null -> {
                Box(Modifier.fillMaxWidth().height(160.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = FridayBrandBlue)
                }
            }
            servers.isEmpty() -> {
                // Empty State
                Card(
                    colors = CardDefaults.cardColors(containerColor = Dash.Card),
                    shape = RoundedCornerShape(18.dp),
                    border = CardDefaults.outlinedCardBorder().copy(brush = androidx.compose.ui.graphics.SolidColor(Dash.CardEdge)),
                    modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                ) {
                    Column(
                        modifier = Modifier.padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(Icons.Outlined.Cloud, null, tint = Dash.Dim, modifier = Modifier.size(48.dp))
                        Spacer(Modifier.height(12.dp))
                        Text("No Servers Enrolled", color = Dash.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "Pair your Linux cloud server to manage AI agent sessions securely from this device.",
                            color = Dash.Dim,
                            fontSize = 13.sp,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(18.dp))
                        Button(
                            onClick = onAddServer,
                            colors = ButtonDefaults.buttonColors(containerColor = FridayBrandBlue),
                            shape = RoundedCornerShape(12.dp),
                        ) {
                            Text("Pair Server Now")
                        }
                    }
                }
            }
            else -> {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(servers) { server ->
                        ServerCard(
                            server = server,
                            onOpenChat = { onOpenChat(server) },
                        )
                    }
                }
            }
        }
    }
}
