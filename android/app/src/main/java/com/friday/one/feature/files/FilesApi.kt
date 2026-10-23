package com.friday.one.feature.files

import com.friday.one.data.FsListResponse
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.Part
import retrofit2.http.Query
import retrofit2.http.Streaming

/**
 * Retrofit interface scoped to the files feature.
 *
 * Kept here rather than in data/Api.kt so WS1 owns its API surface entirely
 * and concurrent agents never collide on that file.
 */
interface FilesApi {

    @GET("fs/list")
    suspend fun listDir(
        @Header("Authorization") bearer: String,
        @Query("path") path: String,
    ): FsListResponse

    /**
     * Streaming response — caller MUST consume body.source() or close it.
     * Do NOT use ResponseBody.string(); read from the stream directly so
     * large files never buffer fully into memory.
     */
    @Streaming
    @GET("fs/download")
    suspend fun download(
        @Header("Authorization") bearer: String,
        @Query("path") path: String,
    ): Response<ResponseBody>

    @Multipart
    @POST("fs/upload")
    suspend fun upload(
        @Header("Authorization") bearer: String,
        @Part dest: MultipartBody.Part,
        @Part file: MultipartBody.Part,
    ): UploadResponse
}
