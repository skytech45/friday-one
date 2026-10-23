package com.friday.one.security

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import java.io.File

/**
 * Decides whether this install is allowed to run, and on what evidence.
 *
 * Read the class comment on [DeviceLockManager] first: every check here is
 * client-side and therefore defeatable by someone who controls the device
 * (Frida hook, patched APK, spoofed `Build` fields). This gate exists to raise
 * the cost and to catch casual cloning, NOT to be a proof. The only check an
 * attacker cannot forge is the server verifying a signature against a public
 * key bound to genuine secure hardware.
 *
 * Design consequence: the verdict is *reported* to the server, which may refuse
 * to serve data. That is what actually protects the data. A local refusal only
 * inconveniences an honest user with a broken key.
 */
class DeviceIntegrityGate(
    private val context: Context,
    private val lock: DeviceLockManager = DeviceLockManager(),
) {

    /** Result of the boot-time check. */
    data class Verdict(
        val allowed: Boolean,
        val reasons: List<String>,
        val securityLevel: DeviceLockManager.KeySecurityLevel,
        val emulator: Boolean,
    ) {
        val summary: String get() = if (allowed) "ok" else reasons.joinToString("; ")
    }

    /**
     * Run every local check.
     *
     * Ordering matters: we test for an emulator first because on an emulator the
     * Keystore will report software-backed, and reporting "hardware key missing"
     * as the primary reason would be misleading.
     */
    fun evaluate(): Verdict {
        val reasons = mutableListOf<String>()

        val emulator = isProbablyEmulator()
        if (emulator) reasons += "emulator environment detected"

        val level = lock.ensureKeyPair().let { lock.existingLevel() ?: it }
        if (level == DeviceLockManager.KeySecurityLevel.MISSING) {
            reasons += "device key could not be created"
        } else if (level == DeviceLockManager.KeySecurityLevel.SOFTWARE) {
            // Not fatal on its own: some legitimate devices (unusual OEMs, some
            // ROMs) have no usable TEE-backed EC keystore. The server decides
            // whether to accept a software key - it should refuse for a
            // high-security app, which is the correct place for that policy.
            reasons += "key is software-backed, not inside secure hardware"
        }

        // Prove the keypair actually works before trusting it. A key that cannot
        // sign is worse than no key, because it would fail later at login.
        if (level != DeviceLockManager.KeySecurityLevel.MISSING) {
            runCatching {
                val challenge = lock.newChallenge()
                val signature = lock.signChallenge(challenge)
                if (!lock.verifyWithOwnKey(challenge, signature)) {
                    reasons += "device key failed self-verification"
                }
            }.onFailure {
                reasons += "device key unusable: ${it.javaClass.simpleName}"
            }
        }

        return Verdict(
            allowed = reasons.isEmpty(),
            reasons = reasons,
            securityLevel = level,
            emulator = emulator,
        )
    }

    // ------------------------------------------------------------ emulator heuristics

    /**
     * Emulator heuristics. Deliberately conservative - a false positive locks a
     * real user out of their own app, which is worse than missing an emulator.
     *
     * All of these are forgeable. `ro.kernel.qemu` is unreadable from an app on
     * modern Android, and a determined attacker sets the rest to real values.
     */
    fun isProbablyEmulator(): Boolean {
        val fingerprint = Build.FINGERPRINT ?: ""
        val model = Build.MODEL ?: ""
        val product = Build.PRODUCT ?: ""
        val hardware = Build.HARDWARE ?: ""
        val manufacturer = Build.MANUFACTURER ?: ""

        var score = 0

        if (fingerprint.startsWith("generic") || fingerprint.contains("vbox") ||
            fingerprint.contains("test-keys")
        ) score++

        if (model.contains("google_sdk") || model.contains("Emulator") ||
            model.contains("Android SDK built for") || model.contains("sdk_gphone")
        ) score++

        if (hardware.contains("goldfish") || hardware.contains("ranchu") ||
            hardware.contains("vbox") || product.contains("sdk")
        ) score++

        if (manufacturer.contains("Genymotion")) score += 2

        // Device is not a phone/tablet at all.
        if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY) &&
            !context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI)
        ) score++

        for (path in EMULATOR_ARTIFACTS) {
            if (File(path).exists()) { score++; break }
        }

        if (Build.SUPPORTED_ABIS?.any { it.contains("x86") } == true &&
            hardware.contains("ranchu")
        ) score += 2

        Log.d(TAG, "emulator heuristics: score=$score")
        // Require 2+ independent signals so one odd Build field cannot lock out
        // a legitimate device.
        return score >= 2
    }

    // ------------------------------------------------------------ Play Integrity

    /**
     * Placeholder for Play Integrity API (or hardware key attestation).
     *
     * This is the only client-side check worth real trust, and even then only
     * because the verdict is a Google-signed token the SERVER verifies - the
     * app cannot forge it. Implementing it needs:
     *   1. Play Console project with the Integrity API enabled.
     *   2. `com.google.android.play:integrity` dependency.
     *   3. `IntegrityManager.requestIntegrityToken(...)` with a server-generated
     *      nonce, then POST the token to the server for decryption/verification
     *      via the Play Integrity server API.
     * Until then this returns null and the server should treat the device as
     * unverifiable but not necessarily hostile.
     */
    fun playIntegrityToken(nonce: String): String? {
        Log.i(TAG, "Play Integrity not configured; nonce=$nonce")
        return null
    }

    private companion object {
        const val TAG = "DeviceIntegrityGate"
        val EMULATOR_ARTIFACTS = listOf(
            "/dev/socket/qemud",
            "/dev/qemu_pipe",
            "/system/lib/libc_malloc_debug_qemu.so",
            "/sys/qemu_trace",
            "/system/bin/qemu-props",
        )
    }
}
