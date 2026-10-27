package com.friday.one.feature.auth

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.one.core.designsystem.Dash
import com.friday.one.core.designsystem.components.cloudFieldColors
import com.friday.one.data.*
import com.friday.one.ui.theme.*
import kotlinx.coroutines.launch

@Composable
internal fun AuthScreen(
    auth: SupabaseAuth,
    onSignedIn: (CloudSession) -> Unit,
    googleError: String?,
) {
    var selectedTab by remember { mutableIntStateOf(0) } // 0 = Sign In, 1 = Create Account
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    val emailOk = android.util.Patterns.EMAIL_ADDRESS.matcher(email.trim()).matches()
    val pwOk = password.length >= 8
    val matchOk = selectedTab == 0 || (password.isNotEmpty() && password == confirmPassword)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Dash.Bg)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        // App Brand Header
        Box(
            modifier = Modifier
                .size(64.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(FridayBrandBlue.copy(alpha = 0.15f))
                .border(1.dp, FridayBrandBlue.copy(alpha = 0.4f), RoundedCornerShape(18.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Outlined.Dns, "Brand Logo", tint = FridayBrandBlue, modifier = Modifier.size(34.dp))
        }
        Spacer(Modifier.height(16.dp))
        Text("FRIDAY One", color = Dash.Text, fontSize = 28.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.5).sp)
        Text("Secure Mobile Control Center for Server AI Agents", color = Dash.Dim, fontSize = 13.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.height(28.dp))

        // Google OAuth Primary Action
        Button(
            onClick = {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(auth.googleAuthorizeUrl()))
                runCatching { context.startActivity(intent) }
                    .onFailure { error = "No browser available for Google sign-in" }
            },
            modifier = Modifier.fillMaxWidth().height(50.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Dash.CardEdge),
            shape = RoundedCornerShape(14.dp),
        ) {
            Icon(Icons.Outlined.Cloud, null, tint = FridayBrandBlue, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Text("Continue with Google", color = Dash.Text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
        }

        Spacer(Modifier.height(18.dp))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            HorizontalDivider(Modifier.weight(1f), color = Dash.CardEdge)
            Text("  or email  ", color = Dash.Dim, fontSize = 12.sp)
            HorizontalDivider(Modifier.weight(1f), color = Dash.CardEdge)
        }
        Spacer(Modifier.height(18.dp))

        // Segmented Tab Selector (Sign In vs Create Account)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(Dash.Card)
                .padding(4.dp),
        ) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (selectedTab == 0) FridayBrandBlue.copy(alpha = 0.2f) else Color.Transparent)
                    .clickable { selectedTab = 0; error = null }
                    .padding(vertical = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "Sign In",
                    color = if (selectedTab == 0) FridayBrandBlue else Dash.Dim,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp,
                )
            }
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (selectedTab == 1) FridayBrandBlue.copy(alpha = 0.2f) else Color.Transparent)
                    .clickable { selectedTab = 1; error = null }
                    .padding(vertical = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "Create Account",
                    color = if (selectedTab == 1) FridayBrandBlue else Dash.Dim,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp,
                )
            }
        }

        Spacer(Modifier.height(20.dp))

        // Form Inputs
        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text("Email address") },
            leadingIcon = { Icon(Icons.Outlined.AccountCircle, null, tint = Dash.Dim) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            colors = cloudFieldColors(),
            shape = RoundedCornerShape(14.dp),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text(if (selectedTab == 1) "Password (min 8 characters)" else "Password") },
            leadingIcon = { Icon(Icons.Outlined.Key, null, tint = Dash.Dim) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            colors = cloudFieldColors(),
            shape = RoundedCornerShape(14.dp),
        )

        if (selectedTab == 1) {
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = confirmPassword,
                onValueChange = { confirmPassword = it },
                label = { Text("Confirm password") },
                leadingIcon = { Icon(Icons.Outlined.Key, null, tint = Dash.Dim) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                isError = confirmPassword.isNotEmpty() && !matchOk,
                supportingText = {
                    if (confirmPassword.isNotEmpty() && !matchOk) {
                        Text("Passwords do not match", color = FridayStatusCrit, fontSize = 11.sp)
                    }
                },
                colors = cloudFieldColors(),
                shape = RoundedCornerShape(14.dp),
            )
        }

        Spacer(Modifier.height(20.dp))

        // Primary Form Submit
        Button(
            onClick = {
                busy = true
                error = null
                notice = null
                scope.launch {
                    if (selectedTab == 0) {
                        runCatching { auth.login(email.trim(), password) }
                            .onSuccess(onSignedIn)
                            .onFailure { error = it.message ?: "Sign in failed" }
                    } else {
                        when (val r = runCatching { auth.register(email.trim(), password) }.getOrElse { e ->
                            error = e.message
                            null
                        }) {
                            is SignupOutcome.SignedIn -> onSignedIn(r.session)
                            SignupOutcome.NeedsEmailConfirmation -> {
                                notice = "Account created! Check your email to confirm, then sign in."
                            }
                            null -> Unit
                        }
                    }
                    busy = false
                }
            },
            enabled = !busy && emailOk && pwOk && matchOk,
            modifier = Modifier.fillMaxWidth().height(50.dp),
            colors = ButtonDefaults.buttonColors(containerColor = FridayBrandBlue),
            shape = RoundedCornerShape(14.dp),
        ) {
            if (busy) {
                CircularProgressIndicator(color = Color.White, modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                Text(
                    if (selectedTab == 0) "Sign In" else "Create Account",
                    color = Color.White,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 15.sp,
                )
            }
        }

        notice?.let {
            Spacer(Modifier.height(14.dp))
            Card(
                colors = CardDefaults.cardColors(containerColor = FridayStatusOk.copy(alpha = 0.15f)),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.CheckCircle, null, tint = FridayStatusOk)
                    Spacer(Modifier.width(8.dp))
                    Text(it, color = FridayStatusOk, fontSize = 12.sp)
                }
            }
        }

        (error ?: googleError)?.let {
            Spacer(Modifier.height(14.dp))
            Card(
                colors = CardDefaults.cardColors(containerColor = FridayStatusCrit.copy(alpha = 0.15f)),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Error, null, tint = FridayStatusCrit)
                    Spacer(Modifier.width(8.dp))
                    Text(it, color = FridayStatusCrit, fontSize = 12.sp)
                }
            }
        }
    }
}
