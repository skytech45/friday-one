package com.friday.one

import android.app.Application
import com.friday.one.data.ApiClient
import com.friday.one.data.CrashRequest
import com.friday.one.security.DeviceIdentity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.PrintWriter
import java.io.StringWriter

/**
 * Installs a handler that reports crashes to the console backend.
 *
 * The report is sent on a best-effort basis and the original handler always
 * runs afterwards, so adding telemetry can never turn a crash into a hang. The
 * fingerprint is included so the backend can link the crash to the device that
 * produced it without needing a live session (many crashes happen at startup,
 * before login).
 */
class FridayApp : Application() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val previousHandler = Thread.getDefaultUncaughtExceptionHandler()

    override fun onCreate() {
        super.onCreate()

        val fingerprint = runCatching { DeviceIdentity.fingerprint(this) }.getOrNull()

        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            runCatching {
                val sw = StringWriter()
                throwable.printStackTrace(PrintWriter(sw))
                val body = CrashRequest(
                    message = "${throwable.javaClass.name}: ${throwable.message ?: "no message"}",
                    stackTrace = sw.toString().take(50_000),
                    severity = "fatal",
                    appVersion = BuildConfig.VERSION_NAME,
                    buildType = if (BuildConfig.DEBUG) "debug" else "release",
                    fingerprint = fingerprint,
                    context = mapOf(
                        "thread" to thread.name,
                        "device" to DeviceIdentity.deviceLabel(),
                        "platform" to DeviceIdentity.platformLabel(),
                    ),
                )
                // Fire and forget with a hard timeout: the process is about to
                // die, so we cannot await a round trip.
                scope.launch {
                    runCatching {
                        ApiClient.create(BuildConfig.BASE_URL).reportCrash(body)
                    }
                }
                Thread.sleep(600)
            }

            previousHandler?.uncaughtException(thread, throwable)
        }
    }
}
