package com.friday.one.feature.cloud

import android.Manifest
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.one.core.designsystem.Dash
import com.friday.one.core.designsystem.components.MetricCard
import com.friday.one.core.designsystem.components.ServerCard
import com.friday.one.core.designsystem.components.cloudFieldColors
import com.friday.one.data.*
import com.friday.one.feature.auth.AuthScreen
import com.friday.one.feature.security.SecurityView
import com.friday.one.ui.theme.*
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.util.UUID
import kotlinx.coroutines.delay
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

// ============================================================================
// 3. DEDICATED SERVER PAIRING SCREEN (QR Scanner + Key Option)
// ============================================================================
@Composable
internal fun ServerPairingScreen(
    accessToken: String,
    existingCount: Int,
    onPairingComplete: () -> Unit,
    onCancel: () -> Unit,
) {
    var serverName by remember { mutableStateOf("vps-${existingCount + 1}") }
    var enrollment by remember { mutableStateOf<EnrollmentInfo?>(null) }
    var codeInput by remember { mutableStateOf("") }
    var claiming by remember { mutableStateOf(false) }
    var generating by remember { mutableStateOf(false) }
    var statusMessage by remember { mutableStateOf<String?>(null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var pairingModeTab by remember { mutableIntStateOf(0) } // 0 = Scan QR, 1 = Pair with Key
    var copiedNotice by remember { mutableStateOf(false) }

    val client = remember { ControlPlaneClient() }
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current

    // ZXing QR Code Scanner Launcher
    val qrLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@rememberLauncherForActivityResult
        val uri = runCatching { Uri.parse(contents) }.getOrNull()
        if (uri?.scheme == "fridayone" && uri.host == "pair") {
            val scannedCode = uri.getQueryParameter("c") ?: ""
            val scannedEnrollment = uri.getQueryParameter("e") ?: enrollment?.enrollmentId ?: ""
            if (scannedCode.length in 16..20 && scannedEnrollment.isNotEmpty()) {
                claiming = true
                statusMessage = "Claiming enrollment and verifying connector..."
                scope.launch {
                    runCatching {
                        client.claimEnrollment(accessToken, scannedEnrollment, scannedCode)
                    }.onSuccess {
                        statusMessage = "Server paired and verified online! ✓"
                        delay(1200)
                        onPairingComplete()
                    }.onFailure {
                        errorMessage = "Pairing failed: ${it.message}"
                        claiming = false
                    }
                }
            } else {
                errorMessage = "QR code did not contain a valid pairing payload"
            }
        } else if (contents.length in 16..20 && contents.all(Char::isDigit)) {
            codeInput = contents
            pairingModeTab = 1
        }
    }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            qrLauncher.launch(
                ScanOptions().apply {
                    setPrompt("Point camera at the server terminal QR code")
                    setBeepEnabled(false)
                    setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                },
            )
        } else {
            errorMessage = "Camera permission is required to scan the terminal QR code"
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Dash.Bg)
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
    ) {
        // Top Bar
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onCancel) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back", tint = Dash.Text)
            }
            Spacer(Modifier.width(6.dp))
            Column(Modifier.weight(1f)) {
                Text("Pair Cloud Server", color = Dash.Text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Text("Connect Linux VPS via the outbound connector", color = Dash.Dim, fontSize = 12.sp)
            }
        }

        Spacer(Modifier.height(18.dp))

        // Step 0: Name & Token Generation (if not generated yet)
        if (enrollment == null) {
            Card(
                colors = CardDefaults.cardColors(containerColor = Dash.Card),
                shape = RoundedCornerShape(18.dp),
                border = CardDefaults.outlinedCardBorder().copy(brush = androidx.compose.ui.graphics.SolidColor(Dash.CardEdge)),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(20.dp)) {
                    Text("1. Name Your Server", color = Dash.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    Text("Choose a friendly name for this server instance", color = Dash.Dim, fontSize = 12.sp)
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = serverName,
                        onValueChange = { serverName = it },
                        label = { Text("Server Name") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        colors = cloudFieldColors(),
                        shape = RoundedCornerShape(12.dp),
                    )
                    Spacer(Modifier.height(16.dp))
                    Button(
                        onClick = {
                            generating = true
                            errorMessage = null
                            scope.launch {
                                runCatching { client.createEnrollment(accessToken, serverName.trim()) }
                                    .onSuccess {
                                        enrollment = it
                                        generating = false
                                    }
                                    .onFailure {
                                        errorMessage = it.message ?: "Failed to create enrollment"
                                        generating = false
                                    }
                            }
                        },
                        enabled = !generating && serverName.isNotBlank(),
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = FridayBrandBlue),
                        shape = RoundedCornerShape(12.dp),
                    ) {
                        if (generating) {
                            CircularProgressIndicator(color = Color.White, modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                        } else {
                            Text("Generate Pairing Session", fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        } else {
            val info = enrollment!!

            // STEP 1 & 2: VPS Terminal Instructions
            Card(
                colors = CardDefaults.cardColors(containerColor = Dash.Card),
                shape = RoundedCornerShape(18.dp),
                border = CardDefaults.outlinedCardBorder().copy(brush = androidx.compose.ui.graphics.SolidColor(Dash.CardEdge)),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(18.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(24.dp)
                                .clip(CircleShape)
                                .background(FridayBrandBlue),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("1", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(Modifier.width(10.dp))
                        Text("Install Connector on Server", color = Dash.Text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                    }
                    Spacer(Modifier.height(8.dp))
                    Text("SSH into your server and run the verified installer:", color = Dash.Dim, fontSize = 12.sp)
                    Spacer(Modifier.height(8.dp))

                    val installCmd = "curl -fsSL https://github.com/skytech45/friday-one/releases/latest/download/install.sh | sudo bash"
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(Dash.Bg)
                            .border(1.dp, Dash.CardEdge, RoundedCornerShape(10.dp))
                            .padding(10.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                installCmd,
                                color = FridayBrandBlue,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 11.sp,
                                modifier = Modifier.weight(1f),
                            )
                            IconButton(
                                onClick = { clipboard.setText(AnnotatedString(installCmd)) },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(Icons.Outlined.ContentCopy, "Copy", tint = Dash.Dim, modifier = Modifier.size(16.dp))
                            }
                        }
                    }

                    Spacer(Modifier.height(18.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(24.dp)
                                .clip(CircleShape)
                                .background(FridayBrandBlue),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("2", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(Modifier.width(10.dp))
                        Text("Start Pairing in Terminal", color = Dash.Text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                    }
                    Spacer(Modifier.height(8.dp))
                    Text("Type this command in your server terminal:", color = Dash.Dim, fontSize = 12.sp)
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "fridayone",
                        color = FridayStatusOk,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(FridayStatusOk.copy(alpha = 0.12f))
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                    )
                    Spacer(Modifier.height(8.dp))
                    Text("When prompted, paste your one-time enrollment token:", color = Dash.Dim, fontSize = 12.sp)
                    Spacer(Modifier.height(8.dp))

                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(Dash.Bg)
                            .border(1.dp, Dash.CardEdge, RoundedCornerShape(10.dp))
                            .padding(10.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                info.token,
                                color = FridayBrandViolet,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.weight(1f),
                            )
                            IconButton(
                                onClick = {
                                    clipboard.setText(AnnotatedString(info.token))
                                    copiedNotice = true
                                },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    if (copiedNotice) Icons.Outlined.Check else Icons.Outlined.ContentCopy,
                                    "Copy Token",
                                    tint = if (copiedNotice) FridayStatusOk else Dash.Dim,
                                    modifier = Modifier.size(16.dp),
                                )

                            }
                        }
                    }
                    if (copiedNotice) {
                        Text("Token copied to clipboard!", color = FridayStatusOk, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
                    }
                }
            }

            Spacer(Modifier.height(18.dp))

            // STEP 3: Connect in App (QR Scan or Key)
            Card(
                colors = CardDefaults.cardColors(containerColor = Dash.Card),
                shape = RoundedCornerShape(18.dp),
                border = CardDefaults.outlinedCardBorder().copy(brush = androidx.compose.ui.graphics.SolidColor(Dash.CardEdge)),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(18.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(24.dp)
                                .clip(CircleShape)
                                .background(FridayBrandBlue),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("3", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(Modifier.width(10.dp))
                        Text("Pair With This Device", color = Dash.Text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                    }
                    Spacer(Modifier.height(14.dp))

                    // Mode Selection Tabs
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(Dash.Bg)
                            .padding(4.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(10.dp))
                                .background(if (pairingModeTab == 0) FridayBrandBlue.copy(alpha = 0.2f) else Color.Transparent)
                                .clickable { pairingModeTab = 0 }
                                .padding(vertical = 10.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Outlined.QrCodeScanner, null, tint = if (pairingModeTab == 0) FridayBrandBlue else Dash.Dim, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(6.dp))
                                Text("Scan Terminal QR", color = if (pairingModeTab == 0) FridayBrandBlue else Dash.Dim, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(10.dp))
                                .background(if (pairingModeTab == 1) FridayBrandBlue.copy(alpha = 0.2f) else Color.Transparent)
                                .clickable { pairingModeTab = 1 }
                                .padding(vertical = 10.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Outlined.Key, null, tint = if (pairingModeTab == 1) FridayBrandBlue else Dash.Dim, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(6.dp))
                                Text("Pair with Key", color = if (pairingModeTab == 1) FridayBrandBlue else Dash.Dim, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }

                    Spacer(Modifier.height(16.dp))

                    if (pairingModeTab == 0) {
                        // Scan QR Mode
                        Text(
                            "Your server terminal will display an ASCII QR code. Point your camera at the terminal to pair instantly.",
                            color = Dash.Dim,
                            fontSize = 12.sp,
                        )
                        Spacer(Modifier.height(14.dp))
                        Button(
                            onClick = {
                                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                            },
                            enabled = !claiming,
                            modifier = Modifier.fillMaxWidth().height(48.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = FridayBrandBlue),
                            shape = RoundedCornerShape(12.dp),
                        ) {
                            Icon(Icons.Outlined.QrCodeScanner, null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("Launch Camera & Scan QR", fontWeight = FontWeight.SemiBold)
                        }
                    } else {
                        // Pair with Key Mode
                        Text(
                            "Enter the 16–20 digit numeric code shown in your server terminal:",
                            color = Dash.Dim,
                            fontSize = 12.sp,
                        )
                        Spacer(Modifier.height(10.dp))
                        OutlinedTextField(
                            value = codeInput,
                            onValueChange = { raw ->
                                codeInput = raw.filter(Char::isDigit).take(20)
                            },
                            placeholder = { Text("e.g. 1029 4820 1928 3920", color = Dash.Dim.copy(alpha = 0.5f)) },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            colors = cloudFieldColors(),
                            shape = RoundedCornerShape(12.dp),
                        )
                        Spacer(Modifier.height(12.dp))
                        Button(
                            onClick = {
                                claiming = true
                                errorMessage = null
                                statusMessage = "Claiming enrollment and verifying connector..."
                                scope.launch {
                                    runCatching {
                                        client.claimEnrollment(accessToken, info.enrollmentId, codeInput)
                                    }.onSuccess {
                                        statusMessage = "Server paired and verified online! ✓"
                                        delay(1200)
                                        onPairingComplete()
                                    }.onFailure {
                                        errorMessage = "Claim failed: ${it.message}"
                                        claiming = false
                                        statusMessage = null
                                    }
                                }
                            },
                            enabled = !claiming && codeInput.length >= 16,
                            modifier = Modifier.fillMaxWidth().height(48.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = FridayBrandBlue),
                            shape = RoundedCornerShape(12.dp),
                        ) {
                            if (claiming) {
                                CircularProgressIndicator(color = Color.White, modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                            } else {
                                Text("Pair with Key", fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }

                    statusMessage?.let {
                        Spacer(Modifier.height(12.dp))
                        Text(it, color = FridayStatusOk, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                    }
                    errorMessage?.let {
                        Spacer(Modifier.height(12.dp))
                        Text(it, color = FridayStatusCrit, fontSize = 12.sp)
                    }
                }
            }
        }
    }
}

// ============================================================================
// 4. MAIN SERVER DASHBOARD VIEW
// ============================================================================
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

// ============================================================================
// 5. LIVE AI AGENT CHAT VIEW (with streaming & permission approval cards)
// ============================================================================
@Composable
internal fun ChatView(
    session: CloudSession,
    server: CloudServer,
    gatewayUrl: String,
    onBack: () -> Unit,
) {
    val client = remember(gatewayUrl) { GatewayClient(gatewayUrl, { session.accessToken }) }
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
                is GatewayEvent.Connected -> status = "Connected to ${server.name}"
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
        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(messages) { (text, isUser) ->
                Box(
                    modifier = Modifier.fillMaxWidth(),
                    contentAlignment = if (isUser) Alignment.CenterEnd else Alignment.CenterStart,
                ) {
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = if (isUser) FridayBrandBlue else Dash.Card,
                        ),
                        shape = RoundedCornerShape(
                            topStart = 16.dp,
                            topEnd = 16.dp,
                            bottomStart = if (isUser) 16.dp else 4.dp,
                            bottomEnd = if (isUser) 4.dp else 16.dp,
                        ),
                        border = if (!isUser) CardDefaults.outlinedCardBorder().copy(brush = androidx.compose.ui.graphics.SolidColor(Dash.CardEdge)) else null,
                        modifier = Modifier.widthIn(max = 300.dp),
                    ) {
                        Text(
                            text = text,
                            color = if (isUser) Color.White else Dash.Text,
                            fontSize = 14.sp,
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                        )
                    }
                }
            }
        }

        // Inline Permission Approval Card (FR-08)
        pendingPerm?.let { (reqId, op) ->
            Card(
                colors = CardDefaults.cardColors(containerColor = Dash.Card),
                shape = RoundedCornerShape(16.dp),
                border = CardDefaults.outlinedCardBorder().copy(brush = androidx.compose.ui.graphics.SolidColor(FridayStatusWarn)),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
            ) {
                Column(Modifier.padding(14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Security, null, tint = FridayStatusWarn, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Permission Required", color = FridayStatusWarn, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    }
                    Spacer(Modifier.height(6.dp))
                    Text("The AI agent wants to execute: $op", color = Dash.Text, fontSize = 13.sp)
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = { client.decide(reqId, false); pendingPerm = null },
                            colors = ButtonDefaults.buttonColors(containerColor = FridayStatusCrit),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("Deny", color = Color.White)
                        }
                        Button(
                            onClick = { client.decide(reqId, true); pendingPerm = null },
                            colors = ButtonDefaults.buttonColors(containerColor = FridayStatusOk),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("Approve", color = Color.White)
                        }
                    }
                }
            }
        }

        // Active Working & Cancel Bar
        if (pendingJob != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Dash.CardEdge.copy(alpha = 0.5f))
                    .padding(horizontal = 16.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(color = FridayBrandBlue, modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text("Agent executing prompt...", color = Dash.Dim, fontSize = 12.sp, modifier = Modifier.weight(1f))
                TextButton(
                    onClick = {
                        client.cancel(pendingJob!!)
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = FridayStatusCrit),
                ) {
                    Icon(Icons.Outlined.Stop, null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("Cancel", fontSize = 12.sp)
                }
            }
        }

        // Message Input Row
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Dash.Card)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                placeholder = { Text("Prompt AI agent on ${server.name}…", color = Dash.Dim, fontSize = 14.sp) },
                modifier = Modifier.weight(1f),
                colors = cloudFieldColors(),
                shape = RoundedCornerShape(14.dp),
                maxLines = 4,
            )
            Spacer(Modifier.width(8.dp))
            IconButton(
                onClick = {
                    val promptText = input.trim()
                    if (promptText.isEmpty()) return@IconButton
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
                enabled = pendingJob == null && input.isNotBlank(),
                modifier = Modifier
                    .size(46.dp)
                    .clip(CircleShape)
                    .background(if (pendingJob == null && input.isNotBlank()) FridayBrandBlue else Dash.CardEdge),
            ) {
                Icon(Icons.Outlined.Send, "Send", tint = Color.White, modifier = Modifier.size(20.dp))
            }
        }
    }
}
