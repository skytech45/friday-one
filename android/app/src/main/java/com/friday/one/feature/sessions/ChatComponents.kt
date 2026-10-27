package com.friday.one.feature.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.one.core.designsystem.Dash
import com.friday.one.core.designsystem.components.cloudFieldColors
import com.friday.one.data.*
import com.friday.one.ui.theme.*

/** Conversation bubbles: user prompts right, agent output left. */
@Composable
internal fun ChatMessageList(messages: List<Pair<String, Boolean>>, modifier: Modifier = Modifier) {
    LazyColumn(
        modifier = modifier
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
}

/** Inline approval prompt for a pending permission request (FR-08). */
@Composable
internal fun PermissionRequestCard(operation: String, onDeny: () -> Unit, onApprove: () -> Unit) {
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
            Text("The AI agent wants to execute: $operation", color = Dash.Text, fontSize = 13.sp)
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = onDeny,
                    colors = ButtonDefaults.buttonColors(containerColor = FridayStatusCrit),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    Text("Deny", color = Color.White)
                }
                Button(
                    onClick = onApprove,
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

/** Shown while a job runs; Cancel sends command.cancel for it. */
@Composable
internal fun JobProgressBar(onCancel: () -> Unit) {
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
            onClick = onCancel,
            colors = ButtonDefaults.textButtonColors(contentColor = FridayStatusCrit),
        ) {
            Icon(Icons.Outlined.Stop, null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(4.dp))
            Text("Cancel", fontSize = 12.sp)
        }
    }
}

/** Prompt field + send button. */
@Composable
internal fun PromptInputRow(
    input: String,
    onInputChange: (String) -> Unit,
    serverName: String,
    sendEnabled: Boolean,
    onSend: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Dash.Card)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value = input,
            onValueChange = onInputChange,
            placeholder = { Text("Prompt AI agent on $serverName…", color = Dash.Dim, fontSize = 14.sp) },
            modifier = Modifier.weight(1f),
            colors = cloudFieldColors(),
            shape = RoundedCornerShape(14.dp),
            maxLines = 4,
        )
        Spacer(Modifier.width(8.dp))
        IconButton(
            onClick = onSend,
            enabled = sendEnabled,
            modifier = Modifier
                .size(46.dp)
                .clip(CircleShape)
                .background(if (sendEnabled) FridayBrandBlue else Dash.CardEdge),
        ) {
            Icon(Icons.Outlined.Send, "Send", tint = Color.White, modifier = Modifier.size(20.dp))
        }
    }
}
