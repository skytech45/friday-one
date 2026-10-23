package com.friday.one.feature.files

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.friday.one.data.FsEntry
import com.friday.one.data.FsListResponse
import com.friday.one.data.SessionStore
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.asRequestBody
import retrofit2.Retrofit
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

/**
 * Repository for filesystem operations.
 *
 * Builds its own Retrofit instance with extended timeouts for large file
 * transfers. Download uses the raw OkHttp ResponseBody stream so files
 * never buffer entirely into memory.
 */
class FsRepository(
    private val context: Context,
    private val sessionStore: SessionStore,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.MINUTES)
        .writeTimeout(5, TimeUnit.MINUTES)
        .build()

    private suspend fun api(): FilesApi {
        val base = sessionStore.baseUrl.first().let { if (it.endsWith("/")) it else "$it/" }
        return Retrofit.Builder()
            .baseUrl(base)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(FilesApi::class.java)
    }

    private suspend fun bearer(): String {
        // File transfers routinely outlive the 15-minute access token, so a large
        // upload or download would die mid-flight with a 401. Refresh on demand.
        val base = sessionStore.baseUrl.first()
        val token = sessionStore.validToken(base)
            ?: throw IllegalStateException("No access token")
        return "Bearer $token"
    }

    suspend fun listDir(path: String): Result<FsListResponse> = withContext(Dispatchers.IO) {
        runCatching {
            api().listDir(bearer(), path)
        }
    }

    /**
     * Stream a file from the server directly to app-internal storage.
     *
     * Returns the local File on success. The caller is responsible for
     * sharing or opening it. We write to getExternalFilesDir() which
     * requires no extra permissions on API 26+.
     */
    suspend fun download(
        remotePath: String,
        fileName: String,
        onProgress: (bytesRead: Long, totalBytes: Long) -> Unit,
    ): Result<File> = withContext(Dispatchers.IO) {
        runCatching {
            val response = api().download(bearer(), remotePath)
            val body = response.body()
                ?: throw RuntimeException("Empty response body")

            val destDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                ?: context.filesDir
            val destFile = File(destDir, fileName)

            val totalBytes = body.contentLength()
            var bytesRead = 0L
            val buffer = ByteArray(8 * 1024)

            body.byteStream().use { input ->
                FileOutputStream(destFile).use { output ->
                    var read: Int
                    while (input.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                        bytesRead += read
                        onProgress(bytesRead, totalBytes)
                    }
                }
            }
            destFile
        }
    }

    /**
     * Upload a file selected via document picker to the current directory.
     *
     * Reads the content through a temp file to support progress reporting
     * without holding the entire file in memory.
     */
    suspend fun upload(
        contentUri: Uri,
        destDir: String,
        onProgress: (bytesSent: Long, totalBytes: Long) -> Unit,
    ): Result<UploadResponse> = withContext(Dispatchers.IO) {
        runCatching {
            // Copy URI content to a temp file so we can report progress and
            // use MultipartBody.Part which needs a File or RequestBody.
            val tempFile = File.createTempFile("upload_", ".tmp", context.cacheDir)
            val totalBytes: Long
            try {
                context.contentResolver.openInputStream(contentUri)?.use { input ->
                    FileOutputStream(tempFile).use { output ->
                        input.copyTo(output)
                    }
                } ?: throw RuntimeException("Cannot open content URI")
                totalBytes = tempFile.length()
            } catch (e: Exception) {
                tempFile.delete()
                throw e
            }

            val fileName = resolveFileName(contentUri) ?: "upload.bin"

            val requestBody = ProgressRequestBody(
                tempFile.asRequestBody("application/octet-stream".toMediaType()),
                totalBytes,
                onProgress,
            )

            val filePart = MultipartBody.Part.createFormData("file", fileName, requestBody)
            val destPart = MultipartBody.Part.createFormData("dest", destDir)

            try {
                api().upload(bearer(), destPart, filePart)
            } finally {
                tempFile.delete()
            }
        }
    }

    private fun resolveFileName(uri: Uri): String? {
        var name: String? = null
        val projection = arrayOf(MediaStore.MediaColumns.DISPLAY_NAME)
        context.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val idx = cursor.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME)
                if (idx >= 0) name = cursor.getString(idx)
            }
        }
        return name
    }
}
