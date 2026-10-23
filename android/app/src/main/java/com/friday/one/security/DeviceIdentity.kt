package com.friday.one.security

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey

/**
 * Hardware-bound device identity.
 *
 * The fingerprint is a SHA-256 over a small set of stable build signals PLUS an
 * install id that lives in a hardware-backed keystore entry. Consequences that
 * matter:
 *
 *  - reinstalling the app keeps the same device (keystore survives), so a user
 *    is not treated as a new device every update;
 *  - copying the app data to another handset does NOT carry the device, because
 *    the keystore key cannot be exported;
 *  - the result is opaque: it cannot be reversed into an advertising id, and it
 *    is hashed again server-side with a pepper before storage.
 *
 * These signals are not secret - they are a stable identifier, not a
 * credential. Authorisation always rests on the session token, never on this.
 */
object DeviceIdentity {

    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "friday_device_install_key"
    private const val PREFS = "friday_device"
    private const val PREF_INSTALL_ID = "install_id"

    @SuppressLint("HardwareIds")
    fun fingerprint(context: Context): String {
        val installId = installId(context)
        val parts = listOf(
            installId,
            Build.FINGERPRINT,
            Build.MODEL,
            Build.MANUFACTURER,
            Build.DEVICE,
            Build.PRODUCT,
            Build.HARDWARE,
            Build.VERSION.RELEASE,
            (context.getSystemService(Context.TELEPHONY_SERVICE) as? android.telephony.TelephonyManager)
                ?.let { if (Build.VERSION.SDK_INT >= 29) "" else @Suppress("DEPRECATION") it.deviceId }
                ?: "",
            @SuppressLint("HardwareIds")
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: "",
        )
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update("friday-device-v1".toByteArray())
        parts.forEach { digest.update(it.toByteArray()) }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun deviceLabel(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    fun platformLabel(): String = "Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})"

    /**
     * An install id that is stable across process death and app updates, but
     * scoped to this device: it is an HMAC of a fixed string under a keystore
     * key, so it cannot be forged off-device.
     */
    private fun installId(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(PREF_INSTALL_ID, null)?.let { return it }

        val id = runCatching {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(keystoreKey())
            mac.doFinal("friday-one-install".toByteArray())
                .joinToString("") { "%02x".format(it) }
        }.getOrElse {
            // Keystore unavailable (rare, e.g. some emulators): fall back to a
            // random id. Still device-scoped, just not hardware-held.
            UUID.randomUUID().toString()
        }

        prefs.edit().putString(PREF_INSTALL_ID, id).apply()
        return id
    }

    private fun keystoreKey(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build()
        )
        return generator.generateKey()
    }
}
