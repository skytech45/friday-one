package com.friday.one.data.auth

import android.annotation.SuppressLint
import android.content.Context
import android.util.Log
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.friday.one.data.CloudSession
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.GoogleAuthProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.tasks.await

/**
 * Firebase Authentication with Google through Credential Manager (decision
 * D2: Google only). The Firebase SDK persists and refreshes the session
 * itself; this class stores no tokens. The Google account password never
 * passes through the app.
 */
class FirebaseAuthRepository(private val appContext: Context) : AuthRepository {

    /** Null when the build has no google-services.json (FirebaseApp not initialized). */
    private val auth: FirebaseAuth? = runCatching { FirebaseAuth.getInstance() }.getOrNull()

    /** OAuth web client ID generated from google-services.json, if present. */
    private val webClientId: String? = run {
        // Looked up by name: the resource exists only when the variant has a
        // google-services.json, so a compile-time R reference would break CI.
        @SuppressLint("DiscouragedApi")
        val id = appContext.resources.getIdentifier("default_web_client_id", "string", appContext.packageName)
        if (id == 0) null else appContext.getString(id).ifBlank { null }
    }

    override val isConfigured: Boolean get() = auth != null && webClientId != null

    override suspend fun current(): CloudSession? {
        val user = auth?.currentUser ?: return null
        val token = try {
            user.getIdToken(false).await().token
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "token refresh failed: ${e.javaClass.simpleName}")
            null
        } ?: return null
        return CloudSession(accessToken = token, refreshToken = "", userId = user.uid, email = user.email ?: "")
    }

    override suspend fun signInWithGoogle(activityContext: Context): AuthResult {
        val firebase = auth ?: return AuthResult.Failed(NOT_CONFIGURED)
        val clientId = webClientId ?: return AuthResult.Failed(NOT_CONFIGURED)
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(GetSignInWithGoogleOption.Builder(clientId).build())
            .build()
        return try {
            val credential = CredentialManager.create(activityContext).getCredential(activityContext, request).credential
            if (credential !is CustomCredential || credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                return AuthResult.Failed("Unexpected credential type from Google sign-in")
            }
            val google = GoogleIdTokenCredential.createFrom(credential.data)
            firebase.signInWithCredential(GoogleAuthProvider.getCredential(google.idToken, null)).await()
            current()?.let { AuthResult.SignedIn(it) } ?: AuthResult.Failed("Signed in, but no session token was issued")
        } catch (e: CancellationException) {
            throw e
        } catch (e: GetCredentialCancellationException) {
            AuthResult.Cancelled
        } catch (e: NoCredentialException) {
            AuthResult.Failed("No Google account is available on this device. Add one in Settings and try again.")
        } catch (e: GetCredentialException) {
            Log.w(TAG, "credential manager: ${e.type}")
            AuthResult.Failed("Google sign-in failed. Check your connection and try again.")
        } catch (e: GoogleIdTokenParsingException) {
            AuthResult.Failed("Google returned an unreadable sign-in token.")
        } catch (e: FirebaseAuthException) {
            Log.w(TAG, "firebase auth: ${e.errorCode}")
            AuthResult.Failed("Sign-in was rejected (${e.errorCode}).")
        } catch (e: Exception) {
            Log.w(TAG, "sign-in failed: ${e.javaClass.simpleName}")
            AuthResult.Failed("Sign-in failed. Try again.")
        }
    }

    override suspend fun signOut() {
        auth?.signOut()
        // Also forget the chosen account, so the next sign-in shows the picker.
        try {
            CredentialManager.create(appContext).clearCredentialState(ClearCredentialStateRequest())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "clear credential state failed: ${e.javaClass.simpleName}")
        }
    }

    private companion object {
        const val TAG = "FridayAuth"
        const val NOT_CONFIGURED = "Sign-in is not configured for this build (missing Firebase config)."
    }
}
