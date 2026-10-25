package com.friday.one.feature.cloud

import androidx.compose.foundation.background
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Security
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
    var showRegister by remember { mutableStateOf(false) }
    var googleError by remember { mutableStateOf<String?>(null) }

    // Google OAuth deep link: fridayone://auth-callback?code=...
    LaunchedEffect(Unit) {
        auth.current()?.let { session = it }
        checking = false
        com.friday.one.data.AuthCallbacks.googleRedirect.collect { uri ->
            if (uri != null) {
                com.friday.one.data.AuthCallbacks.googleRedirect.value = null
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
        checking -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = Dash.Accent)
        }
        session == null && showRegister -> RegisterView(
            auth,
            onRegistered = { s -> session = s },
            onBack = { showRegister = false },
        )
        session == null -> LoginView(
            auth,
            onSignedIn = { s -> session = s },
            onRegister = { showRegister = true },
            googleError = googleError,
        )
        else -> DashboardView(auth, session!!, onSignedOut = {
            scope.launch { auth.clear() }
            session = null
        })
    }
}

@Composable
private fun LoginView(
    auth: SupabaseAuth,
    onSignedIn: (com.friday.one.data.CloudSession) -> Unit,
    onRegister: () -> Unit,
    googleError: String?,
) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current

    Column(
        Modifier.fillMaxSize().background(Dash.Bg).verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("FRIDAY One", color = Dash.Text, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        Text("Your servers, from anywhere", color = Dash.Dim, fontSize = 12.sp)
        Spacer(Modifier.height(24.dp))

        Button(
            onClick = {
                // Custom Tab -> Supabase authorize -> fridayone://auth-callback.
                // If Google isn't enabled yet, Supabase shows a setup error page.
                val intent = android.content.Intent(
                    android.content.Intent.ACTION_VIEW,
                    android.net.Uri.parse(auth.googleAuthorizeUrl()),
                )
                runCatching { context.startActivity(intent) }
                    .onFailure { error = "no browser available" }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Continue with Google") }
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f).height(1.dp).background(Dash.Card))
            Text("  or  ", color = Dash.Dim, fontSize = 11.sp)
            Box(Modifier.weight(1f).height(1.dp).background(Dash.Card))
        }
        Spacer(Modifier.height(12.dp))

        OutlinedTextField(
            value = email, onValueChange = { email = it }, label = { Text("Email") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
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
                    runCatching { auth.login(email.trim(), password) }
                        .onSuccess(onSignedIn)
                        .onFailure { error = it.message ?: "failed" }
                    busy = false
                }
            },
            enabled = !busy && email.isNotBlank() && password.isNotEmpty(),
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (busy) "…" else "Sign in") }
        TextButton(onClick = onRegister) {
            Text("New here? Create an account", color = Dash.Accent, fontSize = 12.sp)
        }
        (error ?: googleError)?.let { Text(it, color = Dash.Bad, fontSize = 12.sp) }
    }
}

/** Plan v2 §10: dedicated register-new-user page. */
@Composable
private fun RegisterView(
    auth: SupabaseAuth,
    onRegistered: (com.friday.one.data.CloudSession) -> Unit,
    onBack: () -> Unit,
) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    val pwOk = password.length >= 8
    val match = password.isNotEmpty() && password == confirm
    val emailOk = android.util.Patterns.EMAIL_ADDRESS.matcher(email.trim()).matches()

    Column(
        Modifier.fillMaxSize().background(Dash.Bg).verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, null, tint = Dash.Text)
            }
            Text("Create account", color = Dash.Text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
        Text("Email + password. You can also use Google later.", color = Dash.Dim, fontSize = 11.sp)
        Spacer(Modifier.height(20.dp))
        OutlinedTextField(
            value = email, onValueChange = { email = it }, label = { Text("Email") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            isError = email.isNotBlank() && !emailOk,
            supportingText = {
                if (email.isNotBlank() && !emailOk) Text("enter a valid email", color = Dash.Bad, fontSize = 11.sp)
            },
            colors = cloudFieldColors(),
        )
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = password, onValueChange = { password = it }, label = { Text("Password (min 8)") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            isError = password.isNotEmpty() && !pwOk,
            colors = cloudFieldColors(),
        )
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = confirm, onValueChange = { confirm = it }, label = { Text("Confirm password") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            isError = confirm.isNotEmpty() && !match,
            supportingText = {
                if (confirm.isNotEmpty() && !match) Text("passwords don't match", color = Dash.Bad, fontSize = 11.sp)
            },
            colors = cloudFieldColors(),
        )
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = {
                busy = true; error = null; notice = null
                scope.launch {
                    when (val r = runCatching { auth.register(email.trim(), password) }.getOrElse { e ->
                        error = e.message; null
                    }) {
                        is com.friday.one.data.SignupOutcome.SignedIn -> onRegistered(r.session)
                        com.friday.one.data.SignupOutcome.NeedsEmailConfirmation -> {
                            notice = "Account created — check your email and confirm, then sign in."
                        }
                        null -> Unit
                    }
                    busy = false
                }
            },
            enabled = !busy && emailOk && pwOk && match,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (busy) "…" else "Create account") }
        notice?.let { Text(it, color = Dash.Accent, fontSize = 12.sp) }
        error?.let { Text(it, color = Dash.Bad, fontSize = 12.sp) }
    }
}

@Composable
private fun DashboardView(auth: SupabaseAuth, session: com.friday.one.data.CloudSession, onSignedOut: () -> Unit) {
    val scope = rememberCoroutineScope()
    var servers by remember { mutableStateOf<List<CloudServer>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var enrollment by remember { mutableStateOf<com.friday.one.data.EnrollmentInfo?>(null) }
    var chatServer by remember { mutableStateOf<CloudServer?>(null) }
    var securityOpen by remember { mutableStateOf(false) }
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

    if (securityOpen) {
        SecurityView(
            accessToken = session.accessToken,
            servers = servers ?: emptyList(),
            onBack = { securityOpen = false; scope.launch { reload() } },
        )
        return
    }

    Column(Modifier.fillMaxSize().background(Dash.Bg).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Servers", color = Dash.Text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text(session.email, color = Dash.Dim, fontSize = 11.sp)
            }
            TextButton(onClick = onSignedOut) {
                Text("Sign out", color = Dash.Bad, fontSize = 12.sp)
            }
            IconButton(onClick = { securityOpen = true }) {
                Icon(Icons.Outlined.Security, "security", tint = Dash.Accent)
            }
        }
        Spacer(Modifier.height(8.dp))
        Button(onClick = {
            scope.launch {
                runCatching { client.createEnrollment(session.accessToken, "server-${(servers?.size ?: 0) + 1}") }
                    .onSuccess { enrollment = it }
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

    enrollment?.let { info ->
        // v2 pairing: install command with the one-time token, then QR/code.
        var codeInput by remember(info.enrollmentId) { mutableStateOf("") }
        var claiming by remember(info.enrollmentId) { mutableStateOf(false) }
        val context = androidx.compose.ui.platform.LocalContext.current
        val scope2 = rememberCoroutineScope()

        // Camera permission -> zxing scanner -> parse fridayone://pair?e=&c=
        val qrLauncher = rememberLauncherForActivityResult(
            com.journeyapps.barcodescanner.ScanContract(),
        ) { result ->
            val contents = result.contents ?: return@rememberLauncherForActivityResult
            val uri = runCatching { android.net.Uri.parse(contents) }.getOrNull()
            if (uri?.scheme == "fridayone" && uri.host == "pair") {
                val scannedCode = uri.getQueryParameter("c") ?: ""
                val scannedEnrollment = uri.getQueryParameter("e") ?: info.enrollmentId
                if (scannedCode.length in 16..20) {
                    claiming = true
                    scope2.launch {
                        runCatching {
                            client.claimEnrollment(session.accessToken, scannedEnrollment, scannedCode)
                        }.onSuccess {
                            enrollment = null
                            reload()
                        }.onFailure { loadError = it.message; enrollment = null }
                    }
                } else {
                    loadError = "QR did not contain a pairing code"
                }
            } else if (contents.length in 16..20 && contents.all(Char::isDigit)) {
                codeInput = contents
            }
        }
        val scanLauncher = rememberLauncherForActivityResult(
            androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
        ) { granted ->
            if (granted) qrLauncher.launch(
                com.journeyapps.barcodescanner.ScanOptions().apply {
                    setPrompt("Point at the FRIDAY pairing QR")
                    setBeepEnabled(false)
                    setDesiredBarcodeFormats(com.journeyapps.barcodescanner.ScanOptions.QR_CODE)
                },
            )
        }

        AlertDialog(
            onDismissRequest = { enrollment = null },
            title = { Text("Pair this server", color = Dash.Text) },
            text = {
                Column {
                    Text("1. On the VPS, run:", color = Dash.Dim, fontSize = 12.sp)
                    Text(
                        "curl -fsSL https://github.com/skytech45/friday-one/releases/latest/download/install.sh | sudo bash -s -- enroll",
                        color = Dash.Text, fontSize = 11.sp,
                    )
                    Text("2. Paste the one-time token:", color = Dash.Dim, fontSize = 12.sp)
                    Text(info.token, color = Dash.Accent, fontSize = 11.sp)
                    Text("3. Scan the QR on the terminal — or type the code:", color = Dash.Dim, fontSize = 12.sp)
                    Button(
                        onClick = {
                            scanLauncher.launch(android.Manifest.permission.CAMERA)
                        },
                        enabled = !claiming,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Scan QR") }
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = codeInput,
                        onValueChange = { codeInput = it.filter(Char::isDigit).take(20) },
                        singleLine = true,
                        colors = cloudFieldColors(),
                    )
                    if (claiming) Text("claiming…", color = Dash.Dim, fontSize = 11.sp)
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !claiming && codeInput.length >= 16,
                    onClick = {
                        claiming = true
                        scope.launch {
                            runCatching { client.claimEnrollment(session.accessToken, info.enrollmentId, codeInput) }
                                .onSuccess {
                                    enrollment = null
                                    reload()
                                }
                                .onFailure { loadError = it.message; enrollment = null }
                        }
                    },
                ) { Text("Pair", color = Dash.Accent) }
            },
            dismissButton = {
                TextButton(onClick = { enrollment = null }) { Text("Cancel", color = Dash.Dim) }
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
