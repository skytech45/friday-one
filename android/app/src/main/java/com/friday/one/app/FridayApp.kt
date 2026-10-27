package com.friday.one.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.friday.one.core.designsystem.Dash
import androidx.compose.ui.platform.LocalContext
import com.friday.one.data.*
import com.friday.one.data.auth.AuthRepository
import com.friday.one.data.auth.AuthResult
import com.friday.one.feature.auth.AuthScreen
import com.friday.one.feature.auth.GoogleSignInScreen
import com.friday.one.ui.theme.*
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
fun FridayApp(legacyAuth: SupabaseAuth, firebaseAuth: AuthRepository?) {
    if (firebaseAuth != null) FirebaseRoot(firebaseAuth) else LegacyRoot(legacyAuth)
}

/** Firebase backend (migration): Google sign-in through Firebase Auth. */
@Composable
private fun FirebaseRoot(auth: AuthRepository) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var session by remember { mutableStateOf<CloudSession?>(null) }
    var checking by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        session = auth.current()
        checking = false
    }
    // Firebase ID tokens expire after an hour. Re-read the session so screens
    // always hand the API and gateway a fresh token; a dead session signs out.
    LaunchedEffect(session?.userId) {
        while (session != null) {
            delay(TOKEN_REFRESH_INTERVAL_MS)
            session = auth.current()
        }
    }

    when {
        checking -> Box(Modifier.fillMaxSize().background(Dash.Bg), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = FridayBrandBlue)
        }
        session == null -> GoogleSignInScreen(
            configured = auth.isConfigured,
            busy = busy,
            error = error,
            onSignIn = {
                scope.launch {
                    busy = true
                    error = null
                    when (val result = auth.signInWithGoogle(context)) {
                        is AuthResult.SignedIn -> session = result.session
                        AuthResult.Cancelled -> Unit
                        is AuthResult.Failed -> error = result.message
                    }
                    busy = false
                }
            },
        )
        else -> AppDashboardShell(
            session = session!!,
            onSignedOut = {
                scope.launch { auth.signOut() }
                session = null
            },
            tokenProvider = { auth.current()?.accessToken },
        )
    }
}

// Firebase refreshes an ID token once it is within 5 minutes of expiry, so
// polling every 4 minutes means the session copy never holds an expired token.
private const val TOKEN_REFRESH_INTERVAL_MS = 4 * 60 * 1000L

/** Legacy Supabase backend, kept unchanged until the Firebase cutover is verified. */
@Composable
private fun LegacyRoot(auth: SupabaseAuth) {
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
            session = session!!,
            onSignedOut = {
                scope.launch { auth.clear() }
                session = null
            },
            // SupabaseAuth.current() refreshes an expiring token first.
            tokenProvider = { auth.current()?.accessToken },
        )
    }
}
