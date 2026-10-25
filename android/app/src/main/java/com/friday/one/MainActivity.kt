package com.friday.one

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import com.friday.one.data.SupabaseAuth
import com.friday.one.feature.cloud.CloudScreen
import com.friday.one.ui.theme.FridayOneTheme

/**
 * FRIDAY One (plan v2.0): the app is the cloud client — Supabase Auth,
 * Vercel control plane, realtime gateway. All legacy direct-to-box screens
 * were removed with the legacy stack.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val cloudAuth = SupabaseAuth(applicationContext)
        setContent {
            FridayOneTheme {
                Surface(Modifier.fillMaxSize()) {
                    CloudScreen(cloudAuth)
                }
            }
        }
    }
}
