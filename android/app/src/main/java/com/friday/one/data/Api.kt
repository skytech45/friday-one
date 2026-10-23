package com.friday.one.data

import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Query
import java.util.concurrent.TimeUnit

@Serializable
data class DevicePayload(
    val fingerprint: String,
    val name: String? = null,
    val platform: String? = null,
    val appVersion: String? = null,
)

@Serializable
data class RegisterRequest(
    val email: String,
    val password: String,
    val displayName: String? = null,
    val fingerprint: String,
    val name: String? = null,
    val platform: String? = null,
    val appVersion: String? = null,
)

@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
    val fingerprint: String,
    val name: String? = null,
    val platform: String? = null,
    val appVersion: String? = null,
)

@Serializable
data class AuthResponse(
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Int = 900,
    val deviceId: String? = null,
    val trusted: Boolean = false,
    val email: String? = null,
    val displayName: String? = null,
)

/**
 * Body of POST /auth/refresh.
 *
 * The fingerprint is required and must match the one bound to the session -
 * the server re-hashes it and refuses a mismatch, which is what prevents a
 * stolen refresh token from being redeemed on a different device.
 */
@Serializable
data class RefreshRequest(
    val refreshToken: String,
    val fingerprint: String,
)

@Serializable
data class CoreInfo(
    val core: Int,
    val usage_pct: Double = 0.0,
    val mhz: Int? = null,
)

@Serializable
data class CpuInfo(
    val cores: Int,
    val usage_pct: Double,
    val model: String = "",
    val per_core: List<CoreInfo> = emptyList(),
    val load: Map<String, Double> = emptyMap(),
)

@Serializable
data class MemoryInfo(
    val total: Long,
    val used: Long,
    val used_pct: Double,
)

@Serializable
data class DiskInfo(
    val total: Long,
    val used: Long,
    val avail: Long,
    val used_pct: Double,
)

@Serializable
data class TempZone(
    val name: String,
    val c: Double,
)

@Serializable
data class TempInfo(
    val cpu_c: Double? = null,
    val zones: List<TempZone> = emptyList(),
)

@Serializable
data class NetIface(
    val name: String,
    val rx_Bps: Double? = null,
    val tx_Bps: Double? = null,
    val up: Boolean = false,
)

@Serializable
data class NetInfo(
    val ifaces: List<NetIface> = emptyList(),
    val rx_Bps: Double? = null,
    val tx_Bps: Double? = null,
)

@Serializable
data class ProcInfo(
    val count: Int = 0,
    val pid: Int = 0,
    val rss: Long = 0,
)

@Serializable
data class MountInfo(
    val fs: String,
    val size: Long,
    val used: Long,
    val usedPct: Double,
)

@Serializable
data class SystemSnapshot(
    val host: String,
    val platform: String,
    val arch: String,
    val uptime_s: Long,
    val booted_at: String = "",
    val cpu: CpuInfo,
    val memory: MemoryInfo,
    val disk: DiskInfo? = null,
    val temp: TempInfo = TempInfo(),
    val net: NetInfo = NetInfo(),
    val proc: ProcInfo = ProcInfo(),
    val mounts: List<MountInfo> = emptyList(),
    val ts: Long = 0,
)

@Serializable
data class FsEntry(
    val name: String,
    val path: String,
    val dir: Boolean,
    val size: Long,
    val mtime: Double = 0.0,
)

@Serializable
data class FsListResponse(
    val path: String,
    val parent: String? = null,
    val roots: List<String> = emptyList(),
    val entries: List<FsEntry> = emptyList(),
)

@Serializable
data class CrashRequest(
    val message: String,
    val stackTrace: String? = null,
    val severity: String = "error",
    val appVersion: String? = null,
    val buildType: String? = null,
    val fingerprint: String? = null,
    val context: Map<String, String> = emptyMap(),
)

/**
 * One Retrofit instance, built lazily. The bearer token is supplied per call
 * rather than baked into an interceptor, so a token rotation (or a logout)
 * cannot leave a stale credential attached to in-flight requests.
 */
object ApiClient {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .apply {
            if (com.friday.one.BuildConfig.DEBUG) {
                addInterceptor(
                    HttpLoggingInterceptor().apply {
                        level = HttpLoggingInterceptor.Level.BASIC
                    }
                )
            }
        }
        .build()

    fun create(baseUrl: String): FridayApi {
        val normalized = if (baseUrl.endsWith("/")) baseUrl else "$baseUrl/"
        return Retrofit.Builder()
            .baseUrl(normalized)
            .client(http)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(FridayApi::class.java)
    }
}

interface FridayApi {
    @GET("health")
    suspend fun health(): Map<String, String>

    @POST("auth/register")
    suspend fun register(@Body body: RegisterRequest): AuthResponse

    @POST("auth/login")
    suspend fun login(@Body body: LoginRequest): AuthResponse

    /**
     * Exchange a refresh token for a new access token.
     *
     * The fingerprint must be the SAME one the session was created with: the
     * backend re-hashes it and requires a match, which is what stops a stolen
     * refresh token from being redeemed on a different handset.
     */
    @POST("auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): AuthResponse

    @GET("me")
    suspend fun me(@Header("Authorization") bearer: String): MeResponse

    @GET("system")
    suspend fun system(@Header("Authorization") bearer: String): SystemSnapshot

    @GET("fs/list")
    suspend fun listDir(
        @Header("Authorization") bearer: String,
        @Query("path") path: String,
    ): FsListResponse

    @POST("crash")
    suspend fun reportCrash(@Body body: CrashRequest): CrashAck
}

@Serializable
data class MeResponse(
    val user: UserDto,
    val device: DeviceDto? = null,
)

@Serializable
data class UserDto(
    val id: String,
    val email: String,
    @SerialName("displayName") val displayName: String? = null,
)

@Serializable
data class DeviceDto(
    val id: String,
    val trusted: Boolean = false,
    val name: String? = null,
    val platform: String? = null,
)

@Serializable
data class CrashAck(
    val ok: Boolean = false,
    val id: String? = null,
    val signature: String? = null,
)
