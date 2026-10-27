package com.friday.one.data.auth

import android.content.Context
import com.friday.one.data.CloudSession

/**
 * Sign-in backend seen by the UI. `CloudSession.accessToken` is the bearer
 * token for the control-plane API and the gateway: a Firebase ID token here.
 */
interface AuthRepository {
    /** False when this build has no Firebase config or no web client ID. */
    val isConfigured: Boolean

    /** Restores the signed-in user with a valid (refreshed if needed) token, or null. */
    suspend fun current(): CloudSession?

    /** Interactive Google sign-in; needs an Activity context for the account picker. */
    suspend fun signInWithGoogle(activityContext: Context): AuthResult

    suspend fun signOut()
}

sealed interface AuthResult {
    data class SignedIn(val session: CloudSession) : AuthResult
    /** The user dismissed the account picker: not an error. */
    data object Cancelled : AuthResult
    data class Failed(val message: String) : AuthResult
}
