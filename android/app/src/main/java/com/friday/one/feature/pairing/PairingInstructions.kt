package com.friday.one.feature.pairing

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.one.core.designsystem.Dash
import com.friday.one.data.*
import com.friday.one.ui.theme.*

/** Steps 1–2: install the connector and start `fridayone` with the token. */
@Composable
internal fun PairingInstructionsCard(
    token: String,
    copiedNotice: Boolean,
    onTokenCopied: () -> Unit,
) {
    val clipboard = LocalClipboardManager.current

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
                        token,
                        color = FridayBrandViolet,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(
                        onClick = {
                            clipboard.setText(AnnotatedString(token))
                            onTokenCopied()
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
}
