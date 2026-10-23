package com.friday.one.security

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.SecureRandom
import java.security.Signature
import java.security.UnrecoverableKeyException
import java.security.cert.Certificate
import java.security.spec.ECGenParameterSpec

/**
 * Hardware-backed device binding.
 *
 * The point of this class is not that the app refuses to run elsewhere - a
 * rooted device can always patch a client-side check. The point is that the
 * private key is generated inside the TEE/StrongBox and is *non-exportable*, so
 * a copied APK moved to another handset cannot produce a valid signature. The
 * guarantee therefore lives on the server: it stores the public key captured at
 * registration and only accepts signatures that verify against it.
 *
 * Everything client-side here is defence in depth and friction, not a proof.
 *
 * API notes worth knowing:
 *  - There is no `setIsHardwareBacked()`. That method does not exist. Hardware
 *    backing is requested for StrongBox via `setIsStrongBoxBacked(true)` and
 *    then *verified* after generation with `KeyInfo.isInsideSecureHardware()`.
 *  - StrongBox is a separate tamper-resistant chip, optional even on API 28+
 *    devices. It is far more restrictive (no key agreement on some chips,
 *    limited algorithms, small keystores), so StrongBox failure is expected on
 *    many devices and must fall back rather than hard-fail.
 *  - Keys are bound to the device. A factory reset, OS downgrade or (on some
 *    devices) a lock-screen change can invalidate them permanently, so callers
 *    must treat "key missing" as "re-register", never as "crash".
 */
class DeviceLockManager(
    private val keyAlias: String = DEFAULT_KEY_ALIAS,
) {

    private val keyStore: KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    /** How the key ended up backed. Reported to the server as context, not as trust. */
    enum class KeySecurityLevel { STRONGBOX, TEE, SOFTWARE, MISSING }

    sealed class DeviceLockError(message: String, cause: Throwable? = null) :
        Exception(message, cause) {
        class KeyGenerationFailed(m: String, c: Throwable? = null) : DeviceLockError(m, c)
        class KeyMissing(m: String) : DeviceLockError(m)
        class SigningFailed(m: String, c: Throwable? = null) : DeviceLockError(m, c)
        class VerificationFailed(m: String) : DeviceLockError(m)
    }

    // ---------------------------------------------------------------- key setup

    /**
     * Create the signing key pair, preferring StrongBox and degrading to TEE.
     *
     * Idempotent: returns the existing key if one is already present, so this is
     * safe to call on every cold start.
     */
    @Throws(DeviceLockError::class)
    fun ensureKeyPair(): KeySecurityLevel {
        existingLevel()?.let { return it }

        // StrongBox first. On most devices this throws and we fall through.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            runCatching { generate(strongBox = true) }
                .onSuccess {
                    Log.i(TAG, "device key generated in StrongBox")
                    return KeySecurityLevel.STRONGBOX
                }
                .onFailure { e ->
                    // StrongBoxUnavailableException, or a ProviderException from a
                    // chip that cannot service the request. Both are normal.
                    Log.i(TAG, "StrongBox unavailable, falling back to TEE: ${e.message}")
                }
        }

        // TEE. Still inside secure hardware on essentially every modern SoC.
        runCatching { generate(strongBox = false) }
            .onFailure { e ->
                throw DeviceLockError.KeyGenerationFailed(
                    "Keystore key generation failed: ${e.javaClass.simpleName}", e
                )
            }

        return existingLevel() ?: KeySecurityLevel.MISSING
    }

    private fun generate(strongBox: Boolean) {
        val builder = KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec(CURVE))
            .setDigests(KeyProperties.DIGEST_SHA256)
            // Deliberately no PURPOSE_DECRYPT and no PURPOSE_ENCRYPT: a signing-only
            // key can never be used to unwrap or exfiltrate anything, so even a
            // full memory compromise of the app yields nothing exportable.
            //
            // No setUserAuthenticationRequired(true) either - the app must verify
            // binding on cold start before any UI, and prompting for biometrics
            // inside a silent integrity check produces a confusing double prompt.
            .setAttestationChallenge(attestationChallenge())

        if (strongBox) builder.setIsStrongBoxBacked(true)

        // setUnlockedDeviceRequired would make the key unusable while the device
        // is locked. That breaks headless/background checks, so it is not set.

        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE).apply {
            initialize(builder.build())
            generateKeyPair()
        }
    }

    /**
     * Read the backing level of the existing key, or null if there is no key.
     * `isInsideSecureHardware()` is the only trustworthy answer here.
     */
    fun existingLevel(): KeySecurityLevel? {
        val privateKey = runCatching {
            keyStore.getKey(keyAlias, null) as? PrivateKey
        }.getOrNull() ?: return null

        val info = runCatching {
            KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE)
                .getKeySpec(privateKey, KeyInfo::class.java) as KeyInfo
        }.getOrNull() ?: return KeySecurityLevel.SOFTWARE

        if (!info.isInsideSecureHardware) return KeySecurityLevel.SOFTWARE

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            runCatching { info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX }
                .getOrDefault(false)
        ) KeySecurityLevel.STRONGBOX else KeySecurityLevel.TEE
    }

    /** True only when the private key is verified to live inside secure hardware. */
    fun isHardwareBacked(): Boolean = existingLevel()?.let {
        it == KeySecurityLevel.STRONGBOX || it == KeySecurityLevel.TEE
    } ?: false

    // ----------------------------------------------------------- sign / verify

    /**
     * Sign a challenge with the hardware-isolated private key.
     *
     * The challenge MUST come from the server and be single-use; a fixed
     * challenge would let an attacker replay a previously captured signature.
     */
    @Throws(DeviceLockError::class)
    fun signChallenge(challenge: ByteArray): ByteArray {
        val privateKey = try {
            keyStore.getKey(keyAlias, null) as? PrivateKey
                ?: throw DeviceLockError.KeyMissing("no device key present; re-registration required")
        } catch (e: UnrecoverableKeyException) {
            // The key exists but is unusable - typically invalidated by a lock
            // screen change or an OS upgrade. Recovery is to wipe and re-register.
            throw DeviceLockError.KeyMissing("device key unusable: ${e.message}")
        }

        val signer = try {
            Signature.getInstance(SIGNATURE_ALGORITHM).apply {
                initSign(privateKey)
                update(challenge)
            }
        } catch (e: ProviderException) {
            throw DeviceLockError.SigningFailed("cannot init signer: ${e.message}", e)
        }

        return try {
            signer.sign()
        } catch (e: Exception) {
            throw DeviceLockError.SigningFailed("signing failed: ${e.message}", e)
        }
    }

    /**
     * Verify a signature against a public key.
     *
     * Used locally to sanity-check our own keypair before trusting it during
     * registration. The authoritative check runs on the server: local
     * verification proves the keypair is internally consistent, NOT that the
     * caller is the legitimate device, because a patched client can simply
     * return true here.
     */
    @Throws(DeviceLockError::class)
    fun verifySignature(
        publicKey: java.security.PublicKey,
        challenge: ByteArray,
        signature: ByteArray,
    ): Boolean = try {
        Signature.getInstance(SIGNATURE_ALGORITHM).apply {
            initVerify(publicKey)
            update(challenge)
        }.verify(signature)
    } catch (e: Exception) {
        throw DeviceLockError.VerificationFailed("verify failed: ${e.message}")
    }

    /** Verify using our own keystore keypair - a self-consistency check. */
    @Throws(DeviceLockError::class)
    fun verifyWithOwnKey(challenge: ByteArray, signature: ByteArray): Boolean =
        verifySignature(publicKey(), challenge, signature)

    // -------------------------------------------------------------- public key

    /**
     * The device's public key, X.509 encoded and Base64'd.
     *
     * This is what gets registered server-side once. It is safe to transmit: it
     * is a public key. It is also what makes the binding work, because a copy of
     * the APK on another handset has a different key.
     */
    @Throws(DeviceLockError::class)
    fun publicKeyEncoded(): String {
        val cert = certificate() ?: throw DeviceLockError.KeyMissing("no certificate for device key")
        return Base64.encodeToString(cert.publicKey.encoded, Base64.NO_WRAP)
    }

    @Throws(DeviceLockError::class)
    fun publicKey(): java.security.PublicKey =
        certificate()?.publicKey ?: throw DeviceLockError.KeyMissing("no certificate for device key")

    private fun certificate(): Certificate? = runCatching { keyStore.getCertificate(keyAlias) }
        .getOrNull()

    /** SHA-256 of the public key - the compact device identifier to register. */
    @Throws(DeviceLockError::class)
    fun publicKeyId(): String =
        sha256Hex(publicKey().encoded)

    /** A fresh, cryptographically random challenge. Server-issued in production. */
    fun newChallenge(bytes: Int = 32): ByteArray =
        ByteArray(bytes).also { SecureRandom().nextBytes(it) }

    private fun attestationChallenge(): ByteArray = newChallenge(24)

    // -------------------------------------------------------------- teardown

    /**
     * Destroy the device key. Only for explicit re-registration or a factory-reset
     * flow - once deleted, every signature this device ever produced becomes
     * unverifiable, and the server must be told to expect a new key.
     */
    fun clearKey() {
        runCatching { keyStore.deleteEntry(keyAlias) }
            .onFailure { Log.w(TAG, "could not delete device key: ${it.message}") }
    }

    private fun sha256Hex(data: ByteArray): String =
        java.security.MessageDigest.getInstance("SHA-256").digest(data)
            .joinToString("") { "%02x".format(it) }

    private companion object {
        const val TAG = "DeviceLockManager"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val DEFAULT_KEY_ALIAS = "friday_device_binding_v1"
        const val CURVE = "secp256r1"                 // P-256, StrongBox-compatible
        const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
    }
}
