package com.friday.one.feature.files

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.friday.one.data.FsEntry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class FilesUiState(
    val currentPath: String = "",
    val parentPath: String? = null,
    val entries: List<FsEntry> = emptyList(),
    val breadcrumbs: List<Breadcrumb> = emptyList(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val sortMode: SortMode = SortMode.NAME,
    val downloadProgress: Float? = null,
    val uploadProgress: Float? = null,
    val snackbarMessage: String? = null,
)

data class Breadcrumb(
    val label: String,
    val path: String,
)

class FilesViewModel(
    private val repository: FsRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(FilesUiState())
    val state: StateFlow<FilesUiState> = _state.asStateFlow()

    init {
        navigateToRoot()
    }

    fun navigateToRoot() {
        // Start at the first root returned by the backend (typically /home/ubuntu).
        // We pass an empty string so the server falls back to ROOTS[0].
        listDirectory("")
    }

    fun navigateTo(path: String) {
        listDirectory(path)
    }

    fun navigateUp() {
        val parent = _state.value.parentPath
        if (parent != null) {
            listDirectory(parent)
        }
    }

    fun setSortMode(mode: SortMode) {
        _state.update { it.copy(sortMode = mode) }
        // Re-sort in-memory without a network call.
        _state.update { it.copy(entries = sortEntries(it.entries, mode)) }
    }

    fun refresh() {
        val path = _state.value.currentPath
        if (path.isNotEmpty()) {
            listDirectory(path)
        } else {
            navigateToRoot()
        }
    }

    fun clearSnackbar() {
        _state.update { it.copy(snackbarMessage = null) }
    }

    fun downloadFile(entry: FsEntry) {
        viewModelScope.launch {
            _state.update { it.copy(downloadProgress = 0f, error = null) }
            val result = repository.download(
                remotePath = entry.path,
                fileName = entry.name,
                onProgress = { bytesRead, totalBytes ->
                    // The repository reports raw byte counts; the UI wants a 0..1
                    // fraction. Guard totalBytes <= 0 because a chunked or
                    // unknown-length response reports -1.
                    val fraction =
                        if (totalBytes > 0) bytesRead.toFloat() / totalBytes else 0f
                    _state.update { it.copy(downloadProgress = fraction.coerceIn(0f, 1f)) }
                }
            )
            result.fold(
                onSuccess = {
                    _state.update {
                        it.copy(
                            downloadProgress = null,
                            snackbarMessage = "Downloaded ${entry.name}"
                        )
                    }
                },
                onFailure = { e ->
                    _state.update {
                        it.copy(
                            downloadProgress = null,
                            error = "Download failed: ${e.message}",
                            snackbarMessage = "Download failed"
                        )
                    }
                }
            )
        }
    }

    fun uploadFile(uri: Uri) {
        viewModelScope.launch {
            _state.update { it.copy(uploadProgress = 0f, error = null) }
            val destDir = _state.value.currentPath
            val result = repository.upload(
                contentUri = uri,
                destDir = destDir,
                onProgress = { bytesSent, totalBytes ->
                    val fraction =
                        if (totalBytes > 0) bytesSent.toFloat() / totalBytes else 0f
                    _state.update { it.copy(uploadProgress = fraction.coerceIn(0f, 1f)) }
                }
            )
            result.fold(
                onSuccess = {
                    _state.update {
                        it.copy(
                            uploadProgress = null,
                            snackbarMessage = "Uploaded to $destDir"
                        )
                    }
                    // Refresh directory listing to show the new file.
                    refresh()
                },
                onFailure = { e ->
                    _state.update {
                        it.copy(
                            uploadProgress = null,
                            error = "Upload failed: ${e.message}",
                            snackbarMessage = "Upload failed"
                        )
                    }
                }
            )
        }
    }

    private fun listDirectory(path: String) {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            val result = repository.listDir(path)
            result.fold(
                onSuccess = { response ->
                    val sorted = sortEntries(response.entries, _state.value.sortMode)
                    val crumbs = buildBreadcrumbs(response.path)
                    _state.update {
                        it.copy(
                            currentPath = response.path,
                            parentPath = response.parent,
                            entries = sorted,
                            breadcrumbs = crumbs,
                            isLoading = false,
                        )
                    }
                },
                onFailure = { e ->
                    _state.update {
                        it.copy(
                            isLoading = false,
                            error = e.message ?: "Unknown error"
                        )
                    }
                }
            )
        }
    }

    private fun sortEntries(entries: List<FsEntry>, mode: SortMode): List<FsEntry> {
        // Directories always come first regardless of sort mode.
        return entries.sortedWith(
            compareByDescending<FsEntry> { it.dir }
                .thenBy { e ->
                    when (mode) {
                        SortMode.NAME -> e.name.lowercase()
                        SortMode.SIZE -> e.size.toString().padStart(20, '0')
                        SortMode.MTIME -> e.mtime.toString()
                    }
                }
        )
    }

    private fun buildBreadcrumbs(path: String): List<Breadcrumb> {
        if (path.isEmpty()) return emptyList()
        val parts = path.split("/").filter { it.isNotEmpty() }
        val crumbs = mutableListOf<Breadcrumb>()
        val sb = StringBuilder()
        for (part in parts) {
            sb.append("/").append(part)
            crumbs.add(Breadcrumb(label = part, path = sb.toString()))
        }
        // Prepend a root crumb so the user can always jump back.
        if (crumbs.isNotEmpty()) {
            crumbs.add(0, Breadcrumb(label = "/", path = "/"))
        }
        return crumbs
    }
}
