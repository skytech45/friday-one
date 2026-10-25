package com.friday.one.feature.cloud

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.one.data.CloudServer
import com.friday.one.data.ControlPlaneClient
import com.friday.one.data.GatewayClient
import com.friday.one.data.GatewayEvent
import com.friday.one.data.SupabaseAuth
import com.friday.one.ui.components.Dash
import kotlinx.coroutines.launch

/**
 * The cloud stack UI (Phase 7): Supabase sign-in → server dashboard with
 * pairing → live agent chat over the gateway. Typed states, explicit
 * loading/error surfaces, single screen per the app's existing style.
 */
@Composable
fun CloudScreen(auth: SupabaseAuth) {
    val scope = rememberCoroutineScope()
    var session by remember { mutableStateOf<com.friday.one.data.CloudSession?>(null) }
    var checking by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) { session = auth.current(); checking = false }

    when {
        checking -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = Dash.Accent)
        }
        session == null -> LoginView(auth) { s -> scope.launch { auth.save(s); session = s } }
        else -> DashboardView(auth, session!!)
    }
}

@Composable
private fun LoginView(auth: SupabaseAuth, onSignedIn: (com.friday.one.data.CloudSession) -> Unit) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf("signin") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        Modifier.fillMaxSize().background(Dash.Bg).verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("FRIDAY One", color = Dash.Text, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        Text("Sign in to your cloud", color = Dash.Dim, fontSize = 12.sp)
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = email, onValueChange = { email = it }, label = { Text("Email") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
            colors = cloudFieldColors(),
        )
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = password, onValueChange = { password = it }, label = { Text("Password") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            colors = cloudFieldColors(),
        )
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = {
                busy = true; error = null
                scope.launch {
                    val r = if (mode == "signin") auth.login(email, password) else auth.signup(email, password)
                    r.onSuccess(onSignedIn).onFailure { error = it.message ?: "failed" }
                    busy = false
                }
            },
            enabled = !busy && email.isNotBlank() && password.length >= 8,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (busy) "…" else if (mode == "signin") "Sign in" else "Create account") }
        TextButton(onClick = { mode = if (mode == "signin") "signup" else "signin" }) {
            Text(if (mode == "signin") "No account? Create one" else "Have an account? Sign in",
                color = Dash.Dim, fontSize = 12.sp)
        }
        error?.let { Text(it, color = Dash.Bad, fontSize = 12.sp) }
    }
}

@Composable
private fun DashboardView(auth: SupabaseAuth, session: com.friday.one.data.CloudSession) {
    val scope = rememberCoroutineScope()
    var servers by remember { mutableStateOf<List<CloudServer>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var pairingCode by remember { mutableStateOf<Pair<String, String>?>(null) } // serverId to code
    var chatServer by remember { mutableStateOf<CloudServer?>(null) }
    val client = remember { ControlPlaneClient() }

    suspend fun reload() {
        try { servers = client.listServers(session.accessToken); loadError = null }
        catch (e: Exception) { loadError = e.message }
    }
    LaunchedEffect(session.accessToken) { reload() }

    chatServer?.let { srv ->
        ChatView(
            session = session,
            server = srv,
            onBack = { chatServer = null; scope.launch { reload() } },
        )
        return
    }

    Column(Modifier.fillMaxSize().background(Dash.Bg).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Servers", color = Dash.Text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text(session.email, color = Dash.Dim, fontSize = 11.sp)
            }
            TextButton(onClick = { scope.launch { auth.clear(); } /* session reset via recreate */ }) {
                Text("Sign out", color = Dash.Bad, fontSize = 12.sp)
            }
        }
        Spacer(Modifier.height(8.dp))
        Button(onClick = {
            scope.launch {
                runCatching { client.createEnrollment(session.accessToken, "server-${servers?.size ?: 0 + 1}") }
                    .onSuccess { pairingCode = it }
                    .onFailure { loadError = it.message }
            }
        }) {
            Icon(Icons.Outlined.Add, null); Spacer(Modifier.width(6.dp)); Text("Add server")
        }
        Spacer(Modifier.height(12.dp))
        loadError?.let { Text(it, color = Dash.Bad, fontSize = 12.sp) }
        when {
            servers == null -> CircularProgressIndicator(color = Dash.Accent)
            servers!!.isEmpty() -> Text(
                "No servers yet — add one, then run the connector's `pair` command with the code.",
                color = Dash.Dim, fontSize = 13.sp)
            else -> LazyColumn {
                items(servers!!) { s ->
                    Card(
                        onClick = {
                            if (s.enrollmentState == "active") chatServer = s
                            else loadError = "Server not active yet — complete pairing first"
                        },
                        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                        colors = CardDefaults.cardColors(containerColor = Dash.Card),
                    ) {
                        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            LiveDot(s.online)
                            Spacer(Modifier.width(10.dp))
                            Column {
                                Text(s.name, color = Dash.Text, fontWeight = FontWeight.SemiBold)
                                Text(
                                    if (s.online) "online" else s.enrollmentState,
                                    color = if (s.online) Dash.Accent else Dash.Dim, fontSize = 11.sp,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    pairingCode?.let { (serverId, code) ->
        AlertDialog(
            onDismissRequest = { pairingCode = null },
            title = { Text("Pair this server", color = Dash.Text) },
            text = {
                Column {
                    Text("Run this on the target server:", color = Dash.Dim, fontSize = 12.sp)
                    Text("`friday-connector pair`", color = Dash.Text, fontSize = 12.sp)
                    Text("with code:", color = Dash.Dim, fontSize = 12.sp)
                    Text(code, color = Dash.Accent, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    Text("Single-use, expires in 15 minutes.", color = Dash.Dim, fontSize = 11.sp)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    pairingCode = null
                    scope.launch { reload() }
                }) { Text("Done", color = Dash.Accent) }
            },
        )
    }
}

@Composable
private fun ChatView(
    session: com.friday.one.data.CloudSession,
    server: CloudServer,
    onBack: () -> Unit,
) {
    val client = remember {
        GatewayClient(com.friday.one.BuildConfig.GATEWAY_URL, { session.accessToken })
    }
    var messages by remember { mutableStateOf(listOf<Pair<String, Boolean>>()) } // text, fromUser
    var input by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("connecting…") }
    var pendingJob by remember { mutableStateOf<String?>(null) }
    var pendingPerm by remember { mutableStateOf<Pair<String, String>?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(server.id) {
        client.events().collect { ev ->
            when (ev) {
                is GatewayEvent.Connected -> status = "online"
                GatewayEvent.Disconnected -> status = "offline"
                is GatewayEvent.JobAccepted -> pendingJob = ev.jobId
                is GatewayEvent.JobStarted -> {}
                is GatewayEvent.Delta -> {
                    messages = messages + Pair(ev.text, false)
                }
                is GatewayEvent.Completed -> {
                    messages = messages + Pair("✓ done (${ev.stopReason})", false)
                    pendingJob = null
                }
                is GatewayEvent.Failed -> {
                    messages = messages + Pair("✗ failed: ${ev.reason}", false)
                    pendingJob = null
                }
                is GatewayEvent.PermissionRequested -> {
                    pendingPerm = ev.requestId to ev.operation
                }
            }
        }
    }

    Column(Modifier.fillMaxSize().background(Dash.Bg)) {
        Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { client.close(); onBack() }) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, null, tint = Dash.Text)
            }
            Column {
                Text(server.name, color = Dash.Text, fontWeight = FontWeight.SemiBold)
                Text(status, color = if (status == "online") Dash.Accent else Dash.Dim, fontSize = 11.sp)
            }
        }
        LazyColumn(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            items(messages) { (text, fromUser) ->
                Box(Modifier.fillMaxWidth(), contentAlignment = if (fromUser) Alignment.CenterEnd else Alignment.CenterStart) {
                    Text(
                        text,
                        color = if (fromUser) Dash.Accent else Dash.Text,
                        fontSize = 14.sp,
                        modifier = Modifier
                            .padding(vertical = 4.dp)
                            .background(if (fromUser) Dash.Card else Dash.Bg)
                            .padding(6.dp),
                    )
                }
            }
        }
        pendingPerm?.let { (requestId, operation) ->
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Allow $operation?", color = Dash.Text, fontSize = 12.sp, modifier = Modifier.weight(1f))
                TextButton(onClick = { client.decide(requestId, false); pendingPerm = null }) { Text("Deny", color = Dash.Bad) }
                TextButton(onClick = { client.decide(requestId, true); pendingPerm = null }) { Text("Allow", color = Dash.Accent) }
            }
        }
        Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = input, onValueChange = { input = it },
                placeholder = { Text("Message ${server.name}…", color = Dash.Dim) },
                modifier = Modifier.weight(1f), colors = cloudFieldColors(),
                maxLines = 3,
            )
            Spacer(Modifier.width(8.dp))
            Button(
                onClick = {
                    val text = input.trim(); if (text.isEmpty()) return@Button
                    input = ""
                    messages = messages + Pair(text, true)
                    val corr = ControlPlaneClient.newJobId()
                    scope.launch {
                        // The chat root: the connector enforces containment + policy.
                        val ok = client.submitPrompt(server.id, "/tmp/friday-acp-test", text, corr)
                        if (!ok) messages = messages + Pair("✗ not connected", false)
                    }
                },
                enabled = status == "online" && pendingJob == null,
            ) { Text("Send") }
        }
        pendingJob?.let {
            Text("working…", color = Dash.Dim, fontSize = 11.sp, modifier = Modifier.padding(8.dp))
        }
    }
}

@Composable

private fun LiveDot(online: Boolean) {
    Box(
        Modifier.size(8.dp).background(if (online) Dash.Accent else Dash.Dim, shape = MaterialTheme.shapes.small),
    )
}

@Composable
private fun cloudFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = Dash.Text,
    unfocusedTextColor = Dash.Text,
    focusedBorderColor = Dash.Accent,
    unfocusedBorderColor = Dash.Dim,
    cursorColor = Dash.Accent,
    focusedLabelColor = Dash.Accent,
    unfocusedLabelColor = Dash.Dim,
)
