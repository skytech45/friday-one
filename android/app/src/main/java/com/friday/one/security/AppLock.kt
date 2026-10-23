package com.friday.one.security

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Biometric gate that must pass before the UI renders when a session exists.
 *
 * Design choices:
 * - Fails closed: any error, cancellation, or biometric unavailability blocks
 *   access rather than falling through to an open UI.
 * - Falls back to device credential (PIN/pattern/password) when biometric
 *   hardware is absent or enrollment is incomplete, so the user is never locked
 *   out by a hardware limitation.
 * - Locks on every cold start only. The Activity's configChanges handle
 *   rotation without re-prompting; ProcessLifecycleOwner or a flag in the
 *   Application class should be used by the caller to distinguish cold start
 *   from background-return if desired.
 */
object AppLock {

    sealed class LockResult {
        data object Granted : LockResult()
        data object Denied : LockResult()
        data class Error(val message: String) : LockResult()
    }

    /**
     * Returns true when the device has biometric OR credential authentication
     * available. Used by the caller to decide whether to show the lock screen.
     */
    fun isAvailable(activity: FragmentActivity): Boolean {
        val manager = BiometricManager.from(activity)
        val canBiometric = manager.canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG or
                BiometricManager.Authenticators.BIOMETRIC_WEAK
        )
        val canCredential = manager.canAuthenticate(
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        )
        return canBiometric == BiometricManager.BIOMETRIC_SUCCESS ||
            canCredential == BiometricManager.BIOMETRIC_SUCCESS
    }

    /**
     * Shows the biometric prompt (with device-credential fallback) and suspends
     * until the user completes it. Always returns a result — never throws.
     *
     * Fail-closed: errors and cancellations map to [LockResult.Denied] or
     * [LockResult.Error], never to [LockResult.Granted].
     */
    suspend fun authenticate(
        activity: FragmentActivity,
        title: String = "Unlock FRIDAY One",
        subtitle: String = "Verify your identity to continue",
    ): LockResult = suspendCancellableCoroutine { cont ->
        // DEVICE_CREDENTIAL cannot be combined with BIOMETRIC_* in a single
        // setAllowedAuthenticators call on API < 30. We try biometric + weak
        // first, and the prompt itself offers the credential fallback.
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setAllowedAuthenticators(authenticators)
            // When DEVICE_CREDENTIAL is allowed, negativeButtonText must not be set.
            .build()

        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                if (cont.isActive) cont.resume(LockResult.Granted)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                // Fail closed: user cancelled, hardware error, or lockout all deny.
                if (cont.isActive) cont.resume(LockResult.Error(errString.toString()))
            }

            override fun onAuthenticationFailed() {
                // Single failure does NOT end the prompt — the system keeps showing it.
                // We do not resume here; only error/success ends the flow.
            }
        }

        val prompt = BiometricPrompt(activity, callback)

        cont.invokeOnCancellation {
            prompt.cancelAuthentication()
            if (cont.isActive) cont.resume(LockResult.Denied)
        }

        runCatching {
            prompt.authenticate(promptInfo)
        }.onFailure { ex ->
            // Fail closed: if the prompt itself throws (e.g., activity finishing),
            // deny rather than grant.
            if (cont.isActive) cont.resume(LockResult.Error(ex.message ?: "prompt failed"))
        }
    }
}

