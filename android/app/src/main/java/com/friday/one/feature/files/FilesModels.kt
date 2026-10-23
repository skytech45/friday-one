package com.friday.one.feature.files

import kotlinx.serialization.Serializable

@Serializable
data class UploadResponse(
    val id: String? = null,
    val path: String? = null,
    val name: String? = null,
    val size: Long = 0,
)

enum class SortMode {
    NAME, SIZE, MTIME
}
