package com.friday.one

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import com.friday.one.data.AuthCallbacks
import com.friday.one.data.SupabaseAuth
import com.friday.one.feature.cloud.CloudScreen
import com.friday.one.ui.theme.FridayOneTheme

/**
 * FRIDAY One (plan v2.0): cloud client — Supabase Auth (email+password AND
 * Google OAuth via PKCE), Vercel control plane, realtime gateway.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val cloudAuth = SupabaseAuth(applicationContext)
        handleAuthRedirect(intent?.data)
        setContent {
            FridayOneTheme {
                Surface(Modifier.fillMaxSize()) {
                    CloudScreen(cloudAuth)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleAuthRedirect(intent.data)
    }

    /** fridayone://auth-callback?code=... from the Supabase OAuth redirect. */
    private fun handleAuthRedirect(uri: Uri?) {
        if (uri != null && uri.scheme == "fridayone" && uri.host == "auth-callback") {
            AuthCallbacks.googleRedirect.value = uri
        }
    }
}
