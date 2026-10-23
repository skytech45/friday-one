package com.friday.one

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import com.friday.one.data.*
import com.friday.one.feature.terminal.TerminalScreen
import com.friday.one.security.DeviceIdentity
import com.friday.one.ui.components.Dash
import com.friday.one.ui.components.GrowDivider
import com.friday.one.ui.components.LiveDot
import com.friday.one.ui.components.LoadBar
import com.friday.one.ui.components.MetricRow
import com.friday.one.ui.components.RingGauge
import com.friday.one.ui.components.SectionLabel
import com.friday.one.ui.components.Sparkline
import com.friday.one.ui.components.fmtBps
import com.friday.one.ui.components.fmtBytes
import com.friday.one.ui.components.fmtUptime
import com.friday.one.ui.theme.FridayOneTheme
import com.friday.one.ui.theme.FridayStatusCrit
import com.friday.one.ui.theme.FridayStatusOk
import com.friday.one.ui.theme.FridayStatusWarn
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private lateinit var session: SessionStore
    private val api = mutableStateOf<FridayApi?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        session = SessionStore(applicationContext)

        setContent {
            FridayOneTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    AppRoot(this, session)
                }
            }
        }
    }
}

private sealed interface Screen {
    data object Machine : Screen
    data object Files : Screen
    data object Hermes : Screen
    data object OpenCode : Screen
    data object Settings : Screen
}

@Composable
private fun AppRoot(activity: ComponentActivity, session: SessionStore) {
    var loggedIn by remember { mutableStateOf<Boolean?>(null) }
    var screen by remember { mutableStateOf<Screen>(Screen.Machine) }
    var baseUrl by remember { mutableStateOf(BuildConfig.BASE_URL) }

    LaunchedEffect(Unit) {
        val stored = session.baseUrl.let { flow -> flow.firstOrNullCompat() }
            ?: BuildConfig.BASE_URL
        baseUrl = stored
        loggedIn = session.accessToken() != null

        // The backend sits behind a quick tunnel whose hostname changes on every
        // restart, so the URL baked into this APK can go stale. Ask the public
        // discovery document where the server is now and repoint automatically.
        // Best-effort by design: offline or a malformed document must not block
        // startup, and refresh() only switches hosts that have already answered.
        runCatching { EndpointDiscovery(session).refresh() }
            .getOrNull()
            ?.let { baseUrl = it }
    }

    when (loggedIn) {
        null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        false -> LoginScreen(
            activity = activity,
            session = session,
            initialBaseUrl = baseUrl,
            onLoggedIn = { url ->
                baseUrl = url
                loggedIn = true
            },
        )
        true -> Scaffold(
            bottomBar = {
                NavigationBar {
                    val items = listOf(
                        Triple(Screen.Machine, "Machine", Icons.Outlined.Memory),
                        Triple(Screen.Files, "Files", Icons.Outlined.Folder),
                        Triple(Screen.Hermes, "Hermes", Icons.Outlined.Terminal),
                        Triple(Screen.OpenCode, "Code", Icons.Outlined.Code),
                        Triple(Screen.Settings, "Settings", Icons.Outlined.Settings),
                    )
                    items.forEach { (target, label, icon) ->
                        NavigationBarItem(
                            selected = screen == target,
                            onClick = { screen = target },
                            icon = { Icon(icon, contentDescription = label) },
                            label = { Text(label, fontSize = 10.sp) },
                        )
                    }
                }
            }
        ) { padding ->
            Box(Modifier.padding(padding)) {
                when (val s = screen) {
                    Screen.Machine -> MachineScreen(session, baseUrl)
                    Screen.Files -> FilesScreen(session, baseUrl)
                    Screen.Hermes -> TerminalScreen(session, baseUrl, "hermes", "Hermes TUI")
                    Screen.OpenCode -> TerminalScreen(session, baseUrl, "opencode", "OpenCode")
                    Screen.Settings -> SettingsScreen(session, baseUrl, onLogout = { loggedIn = false })
                }
            }
        }
    }
}

private suspend fun <T> kotlinx.coroutines.flow.Flow<T>.firstOrNullCompat(): T? =
    runCatching { this.first() }.getOrNull()
@Composable
private fun LoginScreen(
    activity: ComponentActivity,
    session: SessionStore,
    initialBaseUrl: String,
    onLoggedIn: (String) -> Unit,
) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var serverUrl by remember { mutableStateOf(initialBaseUrl) }
    var registerMode by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("FRIDAY", style = MaterialTheme.typography.headlineSmall)
        Text(
            "one console · machine · files · agents",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 4.dp, bottom = 28.dp),
        )

        OutlinedTextField(
            value = serverUrl,
            onValueChange = { serverUrl = it },
            label = { Text("Console URL") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text("Email") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )

        error?.let {
            Text(
                it,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 12.dp),
            )
        }

        Spacer(Modifier.height(20.dp))
        Button(
            onClick = {
                busy = true
                error = null
                activity.lifecycleScope.launch {
                    runCatching {
                        val fp = DeviceIdentity.fingerprint(activity)
                        val api = ApiClient.create(serverUrl)
                        val res = if (registerMode) {
                            api.register(
                                RegisterRequest(
                                    email = email.trim(),
                                    password = password,
                                    fingerprint = fp,
                                    name = DeviceIdentity.deviceLabel(),
                                    platform = DeviceIdentity.platformLabel(),
                                    appVersion = BuildConfig.VERSION_NAME,
                                )
                            )
                        } else {
                            api.login(
                                LoginRequest(
                                    email = email.trim(),
                                    password = password,
                                    fingerprint = fp,
                                    name = DeviceIdentity.deviceLabel(),
                                    platform = DeviceIdentity.platformLabel(),
                                    appVersion = BuildConfig.VERSION_NAME,
                                )
                            )
                        }
                        session.setBaseUrl(serverUrl)
                        session.saveSession(res.accessToken, res.refreshToken, res.email ?: email, res.displayName)
                        onLoggedIn(serverUrl.trim().trimEnd('/'))
                    }.onFailure { e ->
                        error = e.message ?: "Login failed"
                    }
                    busy = false
                }
            },
            enabled = !busy && email.isNotBlank() && password.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            else Text(if (registerMode) "Create account" else "Sign in")
        }

        TextButton(onClick = { registerMode = !registerMode }, modifier = Modifier.fillMaxWidth()) {
            Text(if (registerMode) "I already have an account" else "Create a new account")
        }
    }
}

@Composable
private fun MachineScreen(session: SessionStore, baseUrl: String) {
    var snap by remember { mutableStateOf<SystemSnapshot?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    // Rolling history for the sparklines. Kept here (not in the composable) so a
    // recomposition doesn't reset the trace. 60 samples at 1s = a one-minute window.
    val cpuHist = remember { mutableStateListOf<Float>() }
    val netHist = remember { mutableStateListOf<Float>() }

    LaunchedEffect(baseUrl) {
        while (true) {
            runCatching {
                // validToken(), not accessToken(): the access token lives 15
                // minutes, so polling with the raw token made this screen freeze
                // on stale numbers after a quarter of an hour with a silent 401.
                val token = session.validToken(baseUrl) ?: run {
                    error = "Session expired — please sign in again"
                    return@runCatching
                }
                val s = ApiClient.create(baseUrl).system("Bearer $token")
                snap = s
                error = null

                fun push(list: MutableList<Float>, v: Float) {
                    list.add(v)
                    if (list.size > 60) list.removeAt(0)
                }
                push(cpuHist, s.cpu.usage_pct.toFloat())
                // Normalise throughput for the sparkline: log-ish scaling, because
                // raw bytes/s on a bursty link is a flat line with occasional spikes.
                push(netHist, (((s.net.rx_Bps ?: 0.0) + (s.net.tx_Bps ?: 0.0)) / 1024.0)
                    .toFloat().coerceIn(0f, 4096f))
            }.onFailure { error = it.message }
            kotlinx.coroutines.delay(1000)
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(Dash.Bg)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp),
    ) {
        Spacer(Modifier.height(10.dp))

        // ---- header: host + live pulse ----
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    snap?.host ?: "machine",
                    color = Dash.Text,
                    fontSize = 21.sp,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    snap?.let { "${it.arch} · ${it.platform}" } ?: "connecting…",
                    color = Dash.Dim,
                    fontSize = 11.sp,
                )
            }
            LiveDot(if (error == null) Dash.Accent else Dash.Bad)
            Spacer(Modifier.width(8.dp))
            Text(
                if (error == null) "LIVE" else "OFFLINE",
                color = if (error == null) Dash.Accent else Dash.Bad,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.4.sp,
            )
        }

        error?.let {
            Spacer(Modifier.height(10.dp))
            Box(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(Dash.Bad.copy(alpha = 0.12f))
                    .padding(12.dp)
            ) {
                Text(it, color = Dash.Bad, fontSize = 12.sp)
            }
        }

        // ---- CPU ----
        SectionLabel("CPU")
        Card(
            Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = Dash.Card),
        ) {
            Column(Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(
                        snap?.let { "${"%.0f".format(it.cpu.usage_pct)}" } ?: "--",
                        color = Dash.Text,
                        fontSize = 40.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                    )
                    Text("%", color = Dash.Dim, fontSize = 16.sp, modifier = Modifier.padding(bottom = 6.dp, start = 2.dp))
                    Spacer(Modifier.weight(1f))
                    Column(horizontalAlignment = Alignment.End) {
                        Text(
                            snap?.cpu?.model?.let { m -> m.take(22) } ?: "",
                            color = Dash.Dim, fontSize = 10.sp,
                        )
                        Text(
                            "${snap?.cpu?.cores ?: 0} cores",
                            color = Dash.Dim, fontSize = 10.sp,
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                Sparkline(
                    cpuHist.toList(),
                    Modifier.fillMaxWidth().height(46.dp),
                    color = Dash.heat(snap?.cpu?.usage_pct?.toFloat() ?: 0f),
                    maxValue = 100f,
                )
                Spacer(Modifier.height(12.dp))

                // per-core bars, one row each
                snap?.cpu?.per_core?.forEach { c ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 3.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "CPU${c.core}",
                            color = Dash.Dim, fontSize = 10.sp,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier.width(40.dp),
                        )
                        Box(Modifier.weight(1f)) {
                            LoadBar(c.usage_pct.toFloat(), height = 6)
                        }
                        Spacer(Modifier.width(8.dp))
                        Text(
                            c.mhz?.let { "$it MHz" } ?: "--",
                            color = Dash.Dim, fontSize = 10.sp,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier.width(58.dp),
                        )
                    }
                }

                snap?.cpu?.load?.let { l ->
                    Spacer(Modifier.height(8.dp))
                    GrowDivider()
                    Spacer(Modifier.height(4.dp))
                    MetricRow("Load 1m / 5m / 15m", "%.2f  %.2f  %.2f".format(
                        l["1m"] ?: 0.0, l["5m"] ?: 0.0, l["15m"] ?: 0.0))
                }
                MetricRow("Uptime", fmtUptime(snap?.uptime_s ?: 0))
            }
        }

        // ---- Memory / Disk rings ----
        SectionLabel("Memory & Storage")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Card(
                Modifier.weight(1f),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = Dash.Card),
            ) {
                Column(
                    Modifier.fillMaxWidth().padding(vertical = 16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    RingGauge(
                        pct = snap?.memory?.used_pct?.toFloat() ?: 0f,
                        label = "RAM",
                        value = snap?.let { "${"%.0f".format(it.memory.used_pct)}%" } ?: "--",
                        sub = snap?.let { "${fmtBytes(it.memory.used)} / ${fmtBytes(it.memory.total)}" },
                    )
                }
            }
            Card(
                Modifier.weight(1f),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = Dash.Card),
            ) {
                Column(
                    Modifier.fillMaxWidth().padding(vertical = 16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    RingGauge(
                        pct = snap?.disk?.used_pct?.toFloat() ?: 0f,
                        label = "Disk /",
                        value = snap?.disk?.let { "${"%.0f".format(it.used_pct)}%" } ?: "--",
                        sub = snap?.disk?.let { "${fmtBytes(it.used)} / ${fmtBytes(it.total)}" },
                        colorOverride = Dash.Blue,
                    )
                }
            }
        }

        // ---- Network ----
        SectionLabel("Network")
        Card(
            Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = Dash.Card),
        ) {
            Column(Modifier.padding(16.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column {
                        Text("↓ RX", color = Dash.Dim, fontSize = 10.sp, letterSpacing = 1.sp)
                        Text(
                            fmtBps(snap?.net?.rx_Bps),
                            color = Dash.Accent, fontSize = 17.sp,
                            fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                        )
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text("↑ TX", color = Dash.Dim, fontSize = 10.sp, letterSpacing = 1.sp)
                        Text(
                            fmtBps(snap?.net?.tx_Bps),
                            color = Dash.Blue, fontSize = 17.sp,
                            fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                Sparkline(
                    netHist.toList(),
                    Modifier.fillMaxWidth().height(40.dp),
                    color = Dash.Accent,
                    maxValue = netHist.maxOrNull()?.coerceAtLeast(64f) ?: 64f,
                )
                Spacer(Modifier.height(10.dp))
                GrowDivider()
                Spacer(Modifier.height(4.dp))
                snap?.net?.ifaces?.take(4)?.forEach { i ->
                    MetricRow(
                        i.name,
                        if (i.rx_Bps == null) "--" else fmtBps(i.rx_Bps),
                        accent = if (i.up) Dash.Text else Dash.Dim,
                    ) {
                        Box(
                            Modifier
                                .size(6.dp)
                                .clip(RoundedCornerShape(3.dp))
                                .background(if (i.up) Dash.Accent else Dash.CardEdge)
                        )
                    }
                }
            }
        }

        // ---- Thermals ----
        SectionLabel("Thermals")
        Card(
            Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = Dash.Card),
        ) {
            Column(Modifier.padding(16.dp)) {
                val zones = snap?.temp?.zones ?: emptyList()
                if (zones.isEmpty()) {
                    // Honest empty state. This VM exposes no thermal class at all,
                    // and inventing a plausible temperature would be a lie.
                    Text("No thermal sensors exposed by this host", color = Dash.Dim, fontSize = 12.sp)
                } else {
                    zones.forEach { z ->
                        Row(
                            Modifier.fillMaxWidth().padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                z.name, color = Dash.Dim, fontSize = 11.sp,
                                modifier = Modifier.width(110.dp),
                            )
                            Box(Modifier.weight(1f)) {
                                LoadBar(((z.c - 30.0) / 70.0 * 100).toFloat().coerceIn(0f, 100f), height = 5)
                            }
                            Spacer(Modifier.width(10.dp))
                            Text(
                                "%.0f°C".format(z.c),
                                color = Dash.Text, fontSize = 12.sp,
                                fontFamily = FontFamily.Monospace,
                            )
                        }
                    }
                }
            }
        }

        // ---- Processes ----
        SectionLabel("Processes")
        Card(
            Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = Dash.Card),
        ) {
            Column(Modifier.padding(16.dp)) {
                MetricRow("Running", "${snap?.proc?.count ?: 0}")
                MetricRow("Server RSS", fmtBytes(snap?.proc?.rss ?: 0))
                MetricRow("Server PID", "${snap?.proc?.pid ?: 0}")
                snap?.booted_at?.take(19)?.replace('T', ' ')?.let {
                    MetricRow("Booted", it)
                }
            }
        }

        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun StatCard(label: String, value: String, sub: String) {
    val pct = value.removeSuffix("%").toFloatOrNull() ?: 0f
    val tint = when {
        pct >= 90f -> FridayStatusCrit
        pct >= 70f -> FridayStatusWarn
        else -> FridayStatusOk
    }
    Card(Modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(value, style = MaterialTheme.typography.headlineSmall)
                Text(sub, style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Box(Modifier.size(10.dp).padding(0.dp)) { }
            LinearProgressIndicator(
                progress = { (pct / 100f).coerceIn(0f, 1f) },
                modifier = Modifier.width(64.dp),
                color = tint,
            )
        }
    }
}

@Composable
private fun FilesScreen(session: SessionStore, baseUrl: String) {
    var path by remember { mutableStateOf("/home/ubuntu") }
    var listing by remember { mutableStateOf<FsListResponse?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(path) {
        runCatching {
            // Same 15-minute trap as telemetry: a directory listing fetched with
            // an expired token fails, and the Files tab looks broken.
            val token = session.validToken(baseUrl) ?: return@runCatching
            listing = ApiClient.create(baseUrl).listDir("Bearer $token", path)
            error = null
        }.onFailure { error = it.message }
    }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Files", style = MaterialTheme.typography.headlineSmall)
        Text(path, style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))
        listing?.parent?.let { parent ->
            TextButton(onClick = { path = parent }) { Text("↑ up") }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        LazyColumn {
            items(listing?.entries ?: emptyList()) { e ->
                ListItem(
                    headlineContent = { Text(e.name) },
                    supportingContent = if (e.dir) null else ({ Text(humanSize(e.size)) }),
                    leadingContent = {
                        Icon(
                            if (e.dir) Icons.Outlined.Folder else Icons.Outlined.InsertDriveFile,
                            contentDescription = null,
                        )
                    },
                    modifier = Modifier.clickableIf(e.dir) { path = e.path },
                )
            }
        }
    }
}

@Composable
private fun SettingsScreen(session: SessionStore, baseUrl: String, onLogout: () -> Unit) {
    val activity = androidx.compose.ui.platform.LocalContext.current as ComponentActivity
    var email by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(baseUrl) { email = session.email.firstOrNullCompat() }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Settings", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(16.dp))
        Text("Signed in as ${email ?: "—"}", style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(4.dp))
        Text(baseUrl, style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))
        Text(
            "${DeviceIdentity.deviceLabel()} · ${DeviceIdentity.platformLabel()}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))
        OutlinedButton(
            onClick = {
                activity.lifecycleScope.launch {
                    session.clear()
                    onLogout()
                }
            },
        ) { Text("Sign out") }
    }
}

private fun Modifier.clickableIf(enabled: Boolean, onClick: () -> Unit): Modifier =
    if (enabled) this.clickable(onClick = onClick) else this

private fun gb(bytes: Long): String = "%.1f".format(bytes / 1_073_741_824.0)

private fun humanSize(bytes: Long): String = when {
    bytes >= 1_073_741_824 -> "%.1f GB".format(bytes / 1_073_741_824.0)
    bytes >= 1_048_576 -> "%.1f MB".format(bytes / 1_048_576.0)
    bytes >= 1024 -> "%.0f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}
