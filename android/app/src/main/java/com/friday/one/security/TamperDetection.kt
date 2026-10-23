package com.friday.one.security

import android.os.Build
import java.io.File

/**
 * Root and tamper signal detection.
 *
 * These signals are reported as telemetry context, NEVER as a hard block.
 * Legitimate users run rooted devices; the purpose is to enrich crash reports
 * so backend analysis can correlate failures with device integrity state.
 */
object TamperDetection {

    data class TamperSignals(
        val hasSuBinary: Boolean,
        val hasTestKeys: Boolean,
        val systemWritable: Boolean,
        val summary: String,
    ) {
        fun toTelemetryContext(): Map<String, String> = mapOf(
            "tamper_su" to hasSuBinary.toString(),
            "tamper_test_keys" to hasTestKeys.toString(),
            "tamper_system_writable" to systemWritable.toString(),
            "tamper_summary" to summary,
        )
    }

    /**
     * Collects all available tamper signals without blocking or throwing.
     * Every check is wrapped in runCatching because some OEMs restrict
     * filesystem access in ways that throw SecurityException.
     */
    fun collect(): TamperSignals {
        val su = detectSuBinary()
        val testKeys = detectTestKeys()
        val sysWritable = detectSystemWritable()

        val flags = mutableListOf<String>()
        if (su) flags.add("su")
        if (testKeys) flags.add("test-keys")
        if (sysWritable) flags.add("rw-system")

        val summary = if (flags.isEmpty()) "clean" else flags.joinToString(",")

        return TamperSignals(
            hasSuBinary = su,
            hasTestKeys = testKeys,
            systemWritable = sysWritable,
            summary = summary,
        )
    }

    /**
     * Checks common paths for the `su` binary. Not foolproof against
     * sophisticated root hiding, but catches Magisk, SuperSU, and stock su.
     */
    private fun detectSuBinary(): Boolean = runCatching {
        val paths = listOf(
            "/system/bin/su",
            "/system/xbin/su",
            "/sbin/su",
            "/su/bin/su",
            "/system/app/Superuser.apk",
            "/data/local/su",
            "/data/local/bin/su",
            "/data/local/xbin/su",
        )
        paths.any { File(it).exists() } || runCatching {
            Runtime.getRuntime().exec(arrayOf("/system/xbin/which", "su"))
                .inputStream.bufferedReader().readText().contains("su")
        }.getOrDefault(false)
    }.getOrDefault(false)

    /**
     * Test-keys in Build.TAGS indicates a dev/eng build or a ROM signed with
     * publicly available keys rather than OEM release keys.
     */
    private fun detectTestKeys(): Boolean = runCatching {
        val tags = Build.TAGS ?: ""
        tags.contains("test-keys", ignoreCase = true)
    }.getOrDefault(false)

    /**
     * On a properly secured device, /system is mounted read-only. A writable
     * /system partition indicates either root modifications or an eng build.
     */
    private fun detectSystemWritable(): Boolean = runCatching {
        !File("/system").canWrite().not().let {
            // More reliable: try to check mount flags via /proc/mounts
            val mounts = File("/proc/mounts").readText()
            val systemLine = mounts.lines().find { it.contains(" /system ") }
            if (systemLine != null) {
                // Mount options are the 4th field; "rw" means writable
                val parts = systemLine.split("\\s+".toRegex())
                parts.size >= 4 && parts[3].split(",").any { it == "rw" }
            } else {
                // Fallback: direct write test
                File("/system").canWrite()
            }
        }
    }.getOrDefault(false)
}

