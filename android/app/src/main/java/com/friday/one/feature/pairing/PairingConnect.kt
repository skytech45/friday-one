package com.friday.one.feature.pairing

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.one.core.designsystem.Dash
import com.friday.one.core.designsystem.components.cloudFieldColors
import com.friday.one.data.*
import com.friday.one.ui.theme.*

/** Step 3: pair this device by scanning the terminal QR or typing the key. */
@Composable
internal fun PairingConnectCard(
    pairingModeTab: Int,
    onModeChange: (Int) -> Unit,
    claiming: Boolean,
    codeInput: String,
    onCodeInputChange: (String) -> Unit,
    statusMessage: String?,
    errorMessage: String?,
    onScanQr: () -> Unit,
    onPairWithKey: () -> Unit,
) {
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
                        .clickable { onModeChange(0) }
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
                        .clickable { onModeChange(1) }
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
                    onClick = onScanQr,
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
                        onCodeInputChange(raw.filter(Char::isDigit).take(20))
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
                    onClick = onPairWithKey,
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
