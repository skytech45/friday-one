package com.friday.one.feature.pairing

import android.Manifest
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.one.core.designsystem.Dash
import com.friday.one.core.designsystem.components.cloudFieldColors
import com.friday.one.data.*
import com.friday.one.ui.theme.*
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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

            PairingInstructionsCard(
                token = info.token,
                copiedNotice = copiedNotice,
                onTokenCopied = { copiedNotice = true },
            )

            Spacer(Modifier.height(18.dp))

            PairingConnectCard(
                pairingModeTab = pairingModeTab,
                onModeChange = { pairingModeTab = it },
                claiming = claiming,
                codeInput = codeInput,
                onCodeInputChange = { codeInput = it },
                statusMessage = statusMessage,
                errorMessage = errorMessage,
                onScanQr = { cameraPermissionLauncher.launch(Manifest.permission.CAMERA) },
                onPairWithKey = {
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
            )
        }
    }
}
