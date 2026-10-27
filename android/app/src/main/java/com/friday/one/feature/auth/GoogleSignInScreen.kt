package com.friday.one.feature.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Error
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.one.core.designsystem.Dash
import com.friday.one.ui.theme.FridayBrandBlue
import com.friday.one.ui.theme.FridayStatusCrit

/**
 * Google-only sign-in (decision D2) for the Firebase backend. Stateless: the
 * caller owns busy/error state and performs the sign-in.
 */
@Composable
internal fun GoogleSignInScreen(
    configured: Boolean,
    busy: Boolean,
    error: String?,
    onSignIn: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Dash.Bg)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            modifier = Modifier
                .size(64.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(FridayBrandBlue.copy(alpha = 0.15f))
                .border(1.dp, FridayBrandBlue.copy(alpha = 0.4f), RoundedCornerShape(18.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Outlined.Dns, "FRIDAY One", tint = FridayBrandBlue, modifier = Modifier.size(34.dp))
        }
        Spacer(Modifier.height(16.dp))
        Text("FRIDAY One", color = Dash.Text, fontSize = 28.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.5).sp)
        Text("Secure Mobile Control Center for Server AI Agents", color = Dash.Dim, fontSize = 13.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.height(28.dp))

        Button(
            onClick = onSignIn,
            enabled = configured && !busy,
            modifier = Modifier.fillMaxWidth().height(50.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Dash.CardEdge),
            shape = RoundedCornerShape(14.dp),
        ) {
            if (busy) {
                CircularProgressIndicator(color = FridayBrandBlue, modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            } else {
                Icon(Icons.Outlined.Cloud, null, tint = FridayBrandBlue, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Text("Continue with Google", color = Dash.Text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            }
        }
        Spacer(Modifier.height(12.dp))
        Text(
            "Your Google password is never seen or stored by FRIDAY One.",
            color = Dash.Dim, fontSize = 12.sp, textAlign = TextAlign.Center,
        )

        val message = error ?: if (!configured) "Sign-in is not configured for this build (missing Firebase config)." else null
        message?.let {
            Spacer(Modifier.height(16.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Error, null, tint = FridayStatusCrit)
                Spacer(Modifier.width(8.dp))
                Text(it, color = FridayStatusCrit, fontSize = 12.sp)
            }
        }
    }
}
