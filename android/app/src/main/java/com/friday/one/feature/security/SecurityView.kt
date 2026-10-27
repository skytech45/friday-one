package com.friday.one.feature.security

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.one.core.designsystem.Dash
import com.friday.one.data.AuditEvent
import com.friday.one.data.CloudServer
import com.friday.one.data.Job
import com.friday.one.data.Policy
import kotlinx.coroutines.launch

private val ACTIONS = listOf(
    "session.prompt", "shell.exec", "file.read", "file.write",
    "file.delete", "process.spawn", "credential.access", "terminal.stream",
)
private val DECISIONS = listOf("allow", "deny", "require_approval")

/**
 * Security screen (plan v2 §10): policy editor, job history, audit trail,
 * server revocation. Everything owner-scoped server-side.
 */
@Composable
fun SecurityView(
    accessToken: String,
    servers: List<CloudServer>,
    onBack: () -> Unit,
) {
    val client = remember { com.friday.one.data.ControlPlaneClient() }
    val scope = rememberCoroutineScope()
    var policies by remember { mutableStateOf<List<Policy>?>(null) }
    var jobs by remember { mutableStateOf<List<Job>?>(null) }
    var audit by remember { mutableStateOf<List<AuditEvent>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }
    var confirmRevoke by remember { mutableStateOf<CloudServer?>(null) }

    suspend fun reload() {
        try {
            policies = client.policies(accessToken)
            jobs = client.jobs(accessToken)
            audit = client.audit(accessToken)
            error = null
        } catch (e: Exception) { error = e.message }
    }
    LaunchedEffect(accessToken) { reload() }

    Column(Modifier.fillMaxSize().background(Dash.Bg)) {
        Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, null, tint = Dash.Text)
            }
            Column(Modifier.weight(1f)) {
                Text("Security", color = Dash.Text, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                Text("policies · jobs · audit · revoke", color = Dash.Dim, fontSize = 11.sp)
            }
            IconButton(onClick = { adding = true }) {
                Icon(Icons.Outlined.Add, "add policy", tint = Dash.Accent)
            }
        }
        error?.let { Text(it, color = Dash.Bad, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 12.dp)) }

        when {
            policies == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Dash.Accent)
            }
            else -> LazyColumn(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
                item {
                    SectionLabel("POLICIES (${policies!!.size})")
                }
                if (policies!!.isEmpty()) {
                    item { Hint("No rules — unmatched sensitive actions fail closed (require approval).") }
                }
                items(policies!!) { p ->
                    Card(Modifier.fillMaxWidth().padding(vertical = 4.dp), colors = cardColors()) {
                        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("${p.action} → ${p.decision}", color = Dash.Text, fontSize = 13.sp)
                                Text(p.serverName, color = Dash.Dim, fontSize = 11.sp)
                            }
                            Switch(
                                checked = p.enabled,
                                onCheckedChange = { on_ ->
                                    scope.launch {
                                        runCatching { client.setPolicyEnabled(accessToken, p.id, on_) }
                                            .onFailure { error = it.message }
                                        reload()
                                    }
                                },
                            )
                            IconButton(onClick = {
                                scope.launch {
                                    runCatching { client.deletePolicy(accessToken, p.id) }
                                        .onFailure { error = it.message }
                                    reload()
                                }
                            }) { Icon(Icons.Outlined.Delete, "delete", tint = Dash.Bad) }
                        }
                    }
                }

                item { Spacer(Modifier.height(12.dp)); SectionLabel("RECENT JOBS") }
                if (jobs!!.isEmpty()) item { Hint("No commands run yet.") }
                items(jobs!!) { j ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                        Text(j.id, color = Dash.Dim, fontSize = 11.sp, modifier = Modifier.width(70.dp))
                        Text(j.operation, color = Dash.Text, fontSize = 12.sp, modifier = Modifier.weight(1f))
                        Text(j.state, color = when (j.state) {
                            "completed" -> Dash.Accent
                            "failed" -> Dash.Bad
                            else -> Dash.Dim
                        }, fontSize = 11.sp)
                    }
                }

                item { Spacer(Modifier.height(12.dp)); SectionLabel("AUDIT") }
                if (audit!!.isEmpty()) item { Hint("No audit events yet.") }
                items(audit!!) { a ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                        Text(a.at, color = Dash.Dim, fontSize = 11.sp, modifier = Modifier.width(130.dp))
                        Text(a.action, color = Dash.Text, fontSize = 12.sp)
                    }
                }

                item { Spacer(Modifier.height(16.dp)); SectionLabel("REVOKE SERVER") }
                items(servers.filter { it.enrollmentState == "active" }) { s ->
                    Card(Modifier.fillMaxWidth().padding(vertical = 4.dp), colors = cardColors()) {
                        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(s.name, color = Dash.Text, fontSize = 13.sp, modifier = Modifier.weight(1f))
                            TextButton(onClick = { confirmRevoke = s }) {
                                Text("Revoke", color = Dash.Bad, fontSize = 12.sp)
                            }
                        }
                    }
                }
                item { Spacer(Modifier.height(30.dp)) }
            }
        }
    }

    if (adding) {
        var action by remember { mutableStateOf(ACTIONS[0]) }
        var decision by remember { mutableStateOf(DECISIONS[0]) }
        var scopeServer by remember { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { adding = false },
            title = { Text("Add policy", color = Dash.Text) },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text("Action", color = Dash.Dim, fontSize = 11.sp)
                    ACTIONS.forEach { a ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = action == a, onClick = { action = a })
                            Text(a, color = Dash.Text, fontSize = 12.sp)
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    Text("Decision", color = Dash.Dim, fontSize = 11.sp)
                    DECISIONS.forEach { d ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = decision == d, onClick = { decision = d })
                            Text(d, color = Dash.Text, fontSize = 12.sp)
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    Text("Applies to", color = Dash.Dim, fontSize = 11.sp)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = scopeServer == null, onClick = { scopeServer = null })
                        Text("all my servers", color = Dash.Text, fontSize = 12.sp)
                    }
                    servers.filter { it.enrollmentState == "active" }.forEach { s ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = scopeServer == s.id, onClick = { scopeServer = s.id })
                            Text(s.name, color = Dash.Text, fontSize = 12.sp)
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    adding = false
                    scope.launch {
                        runCatching { client.addPolicy(accessToken, scopeServer, action, decision) }
                            .onFailure { error = it.message }
                        reload()
                    }
                }) { Text("Add", color = Dash.Accent) }
            },
            dismissButton = { TextButton(onClick = { adding = false }) { Text("Cancel", color = Dash.Dim) } },
        )
    }

    confirmRevoke?.let { s ->
        AlertDialog(
            onDismissRequest = { confirmRevoke = null },
            title = { Text("Revoke ${s.name}?", color = Dash.Text) },
            text = { Text("The connector's credential dies immediately; it cannot reconnect. Re-pairing requires a fresh enrollment.", color = Dash.Dim, fontSize = 12.sp) },
            confirmButton = {
                TextButton(onClick = {
                    val target = s; confirmRevoke = null
                    scope.launch {
                        runCatching { client.revokeServer(accessToken, target.id) }
                            .onFailure { error = it.message }
                        reload()
                    }
                }) { Text("Revoke", color = Dash.Bad) }
            },
            dismissButton = { TextButton(onClick = { confirmRevoke = null }) { Text("Cancel", color = Dash.Dim) } },
        )
    }
}

@Composable
private fun SectionLabel(t: String) {
    Text(t, color = Dash.Dim, fontSize = 10.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(vertical = 6.dp))
}

@Composable
private fun Hint(t: String) {
    Text(t, color = Dash.Dim, fontSize = 11.sp, modifier = Modifier.padding(vertical = 6.dp))
}

@Composable
private fun cardColors() = CardDefaults.cardColors(containerColor = Dash.Card)
