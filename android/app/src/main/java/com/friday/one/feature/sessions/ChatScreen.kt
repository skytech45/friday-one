package com.friday.one.feature.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.one.core.designsystem.Dash
import com.friday.one.data.*
import com.friday.one.ui.theme.*
import java.util.UUID
import kotlinx.coroutines.launch

@Composable
internal fun ChatView(
    session: CloudSession,
    server: CloudServer,
    gatewayUrl: String,
    onBack: () -> Unit,
    /** Fresh token per (re)connect; Cloud Run drops sockets at 60 min. */
    tokenProvider: suspend () -> String? = { session.accessToken },
) {
    val currentTokenProvider by rememberUpdatedState(tokenProvider)
    val client = remember(gatewayUrl) { GatewayClient(gatewayUrl, { currentTokenProvider() }) }
    var reconnecting by remember { mutableStateOf(false) }
    var messages by remember { mutableStateOf(listOf<Pair<String, Boolean>>()) } // text to isUser
    var input by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("Connecting to gateway...") }
    var pendingJob by remember { mutableStateOf<String?>(null) }
    var pendingPerm by remember { mutableStateOf<Pair<String, String>?>(null) } // requestId to operation

    // Capability-driven pickers (plan §9)
    val selectableAgents = remember(server.id) {
        server.agents.filter { it.health == "healthy" }.ifEmpty { server.agents }
    }
    var selectedAgent by remember(server.id) {
        mutableStateOf(selectableAgents.firstOrNull()?.adapter)
    }
    var selectedRoot by remember(server.id) {
        mutableStateOf(server.projects.firstOrNull()?.root ?: "/tmp/friday-acp-test")
    }
    val scope = rememberCoroutineScope()

    LaunchedEffect(server.id) {
        client.events().collect { ev ->
            when (ev) {
                is GatewayEvent.Connected -> {
                    status = "Connected to ${server.name}"
                    if (reconnecting && pendingJob != null) {
                        // Nothing is replayed across a reconnect: say so.
                        messages = messages + Pair("⚠ Reconnected — output sent while offline may be missing", false)
                    }
                    reconnecting = false
                }
                is GatewayEvent.Reconnecting -> {
                    reconnecting = true
                    status = "Connection lost — reconnecting in ${(ev.delayMs + 999) / 1000}s"
                }
                GatewayEvent.AuthFailed -> status = "Session expired — sign in again"
                GatewayEvent.Disconnected -> status = "Gateway Disconnected"
                is GatewayEvent.JobAccepted -> pendingJob = ev.jobId
                is GatewayEvent.JobStarted -> {}
                is GatewayEvent.Delta -> {
                    messages = messages + Pair(ev.text, false)
                }
                is GatewayEvent.Completed -> {
                    messages = messages + Pair("✓ Completed (${ev.stopReason})", false)
                    pendingJob = null
                }
                is GatewayEvent.Failed -> {
                    messages = messages + Pair("✗ Failed: ${ev.reason}", false)
                    pendingJob = null
                }
                is GatewayEvent.Rejected -> {
                    messages = messages + Pair("✗ Rejected: ${ev.reason}", false)
                    pendingJob = null
                }
                is GatewayEvent.PermissionRequested -> {
                    pendingPerm = ev.requestId to ev.operation
                }
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Dash.Bg),
    ) {
        // Chat Header
        Surface(
            color = Dash.Card,
            shadowElevation = 2.dp,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column {
                Row(
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = { client.close(); onBack() }) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back", tint = Dash.Text)
                    }
                    Column(Modifier.weight(1f)) {
                        Text(server.name, color = Dash.Text, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                modifier = Modifier
                                    .size(6.dp)
                                    .clip(CircleShape)
                                    .background(if (status.startsWith("Connected")) FridayStatusOk else FridayStatusWarn),
                            )
                            Spacer(Modifier.width(6.dp))
                            Text(status, color = Dash.Dim, fontSize = 11.sp)
                        }
                    }
                    // Active Agent Indicator
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(FridayBrandBlue.copy(alpha = 0.15f))
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    ) {
                        val activeLabel = selectedAgent?.replaceFirstChar { it.uppercase() } ?: "Agent"
                        Text(activeLabel, color = FridayBrandBlue, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    }
                }

                // Capability Pickers (if multiple agents or projects are available)
                if (selectableAgents.size > 1) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Agent:", color = Dash.Dim, fontSize = 11.sp)
                        selectableAgents.forEach { a ->
                            FilterChip(
                                selected = selectedAgent == a.adapter,
                                onClick = { selectedAgent = a.adapter },
                                label = {
                                    Text(
                                        a.adapter.replaceFirstChar { it.uppercase() } +
                                            (a.version?.let { " · $it" } ?: ""),
                                        fontSize = 11.sp,
                                    )
                                },
                            )
                        }
                    }
                }
                if (server.projects.size > 1) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Project:", color = Dash.Dim, fontSize = 11.sp)
                        server.projects.forEach { p ->
                            FilterChip(
                                selected = selectedRoot == p.root,
                                onClick = { selectedRoot = p.root },
                                label = {
                                    Text((p.label ?: p.root).take(20), fontSize = 11.sp)
                                },
                            )
                        }
                    }
                }
            }
        }

        // Messages Stream
        ChatMessageList(messages = messages, modifier = Modifier.weight(1f))

        // Inline Permission Approval Card (FR-08)
        pendingPerm?.let { (reqId, op) ->
            PermissionRequestCard(
                operation = op,
                onDeny = { client.decide(reqId, false); pendingPerm = null },
                onApprove = { client.decide(reqId, true); pendingPerm = null },
            )
        }

        // Active Working & Cancel Bar
        if (pendingJob != null) {
            JobProgressBar(onCancel = { client.cancel(pendingJob!!) })
        }

        // Message Input Row
        PromptInputRow(
            input = input,
            onInputChange = { input = it },
            serverName = server.name,
            sendEnabled = pendingJob == null && input.isNotBlank(),
            onSend = {
                val promptText = input.trim()
                if (promptText.isEmpty()) return@PromptInputRow
                input = ""
                messages = messages + Pair(promptText, true)
                val corr = UUID.randomUUID().toString()
                scope.launch {
                    val dispatched = client.submitPrompt(
                        server.id, selectedRoot, promptText, corr, selectedAgent,
                    )
                    if (!dispatched) {
                        messages = messages + Pair("✗ Could not dispatch prompt to gateway", false)
                    }
                }
            },
        )
    }
}
