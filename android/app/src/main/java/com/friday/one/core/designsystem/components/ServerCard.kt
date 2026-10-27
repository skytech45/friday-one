package com.friday.one.core.designsystem.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.one.core.designsystem.Dash
import com.friday.one.data.*
import com.friday.one.ui.theme.*

@Composable
internal fun ServerCard(server: CloudServer, onOpenChat: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = Dash.Card),
        shape = RoundedCornerShape(16.dp),
        border = CardDefaults.outlinedCardBorder().copy(brush = androidx.compose.ui.graphics.SolidColor(Dash.CardEdge)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Status Dot
            Box(
                modifier = Modifier
                    .size(10.dp)
                    .clip(CircleShape)
                    .background(if (server.online) FridayStatusOk else Dash.Dim),
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(server.name, color = Dash.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (server.online) "Online · Active" else "State: ${server.enrollmentState}",
                        color = if (server.online) FridayStatusOk else Dash.Dim,
                        fontSize = 12.sp,
                    )
                }
                if (server.agents.isNotEmpty()) {
                    Text(
                        server.agents.joinToString(", ") { it.adapter } +
                            " · ${server.projects.size} root(s)",
                        color = Dash.Dim, fontSize = 10.sp,
                    )
                }
            }
            Button(
                onClick = onOpenChat,
                enabled = server.enrollmentState == "active",
                colors = ButtonDefaults.buttonColors(containerColor = if (server.online) FridayBrandBlue else Dash.CardEdge),
                shape = RoundedCornerShape(12.dp),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
            ) {
                Text("Open Chat", fontSize = 13.sp, color = if (server.online) Color.White else Dash.Dim)
            }
        }
    }
}
