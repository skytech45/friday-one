package com.friday.one.feature.files

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Sort
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.friday.one.data.FsEntry
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesScreen(
    viewModel: FilesViewModel,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    // Show snackbar messages from the ViewModel.
    LaunchedEffect(state.snackbarMessage) {
        state.snackbarMessage?.let { msg ->
            snackbarHostState.showSnackbar(msg)
            viewModel.clearSnackbar()
        }
    }

    // Document picker for upload — scoped to this feature, no changes to MainActivity.
    val uploadLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri != null) {
            viewModel.uploadFile(uri)
        }
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = { Text("Files", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    if (state.parentPath != null) {
                        IconButton(onClick = { viewModel.navigateUp() }) {
                            Icon(Icons.Default.ArrowBack, contentDescription = "Go up")
                        }
                    }
                },
                actions = {
                    SortMenu(
                        currentSort = state.sortMode,
                        onSortSelected = { viewModel.setSortMode(it) }
                    )
                }
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { uploadLauncher.launch(arrayOf("*/*")) }) {
                Icon(Icons.Default.Upload, contentDescription = "Upload file")
            }
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            // Breadcrumb bar
            BreadcrumbBar(
                breadcrumbs = state.breadcrumbs,
                onCrumbClick = { crumb -> viewModel.navigateTo(crumb.path) }
            )

            // Global progress indicator for active uploads/downloads
            when {
                state.downloadProgress != null -> {
                    LinearProgressIndicator(
                        progress = { state.downloadProgress ?: 0f },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
                state.uploadProgress != null -> {
                    LinearProgressIndicator(
                        progress = { state.uploadProgress ?: 0f },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }

            // Error banner
            state.error?.let { err ->
                Text(
                    text = err,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            // File list with pull-to-refresh
            PullToRefreshBox(
                isRefreshing = state.isLoading,
                onRefresh = { viewModel.refresh() },
                modifier = Modifier.fillMaxSize(),
            ) {
                if (state.entries.isEmpty() && !state.isLoading) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("Empty directory", style = MaterialTheme.typography.bodyLarge)
                    }
                } else {
                    LazyColumn(
                        contentPadding = PaddingValues(bottom = 88.dp), // clear the FAB
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(
                            items = state.entries,
                            key = { it.path },
                        ) { entry ->
                            FileRow(
                                entry = entry,
                                onNavigate = { viewModel.navigateTo(entry.path) },
                                onDownload = { viewModel.downloadFile(entry) },
                            )
                            HorizontalDivider()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BreadcrumbBar(
    breadcrumbs: List<Breadcrumb>,
    onCrumbClick: (Breadcrumb) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        breadcrumbs.forEachIndexed { index, crumb ->
            if (index > 0) {
                Text(
                    text = " / ",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                text = crumb.label,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (index == breadcrumbs.lastIndex) FontWeight.Bold else FontWeight.Normal,
                color = if (index == breadcrumbs.lastIndex) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    MaterialTheme.colorScheme.primary
                },
                modifier = Modifier.clickable { onCrumbClick(crumb) },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun FileRow(
    entry: FsEntry,
    onNavigate: () -> Unit,
    onDownload: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable {
                if (entry.dir) onNavigate()
            }
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = if (entry.dir) Icons.Default.Folder else Icons.Default.Description,
            contentDescription = null,
            tint = if (entry.dir) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(24.dp),
        )
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = entry.name,
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (!entry.dir) {
                Text(
                    text = "${formatSize(entry.size)} · ${formatMtime(entry.mtime)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Text(
                    text = formatMtime(entry.mtime),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        // Download button only for files, not directories.
        if (!entry.dir) {
            IconButton(onClick = onDownload) {
                Icon(
                    Icons.Default.Download,
                    contentDescription = "Download ${entry.name}",
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
        }
    }
}

@Composable
private fun SortMenu(
    currentSort: SortMode,
    onSortSelected: (SortMode) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { expanded = true }) {
            Icon(Icons.Default.Sort, contentDescription = "Sort files")
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            SortMode.entries.forEach { mode ->
                DropdownMenuItem(
                    text = {
                        Text(
                            text = when (mode) {
                                SortMode.NAME -> "Name"
                                SortMode.SIZE -> "Size"
                                SortMode.MTIME -> "Modified"
                            },
                            fontWeight = if (mode == currentSort) FontWeight.Bold else FontWeight.Normal,
                        )
                    },
                    onClick = {
                        onSortSelected(mode)
                        expanded = false
                    },
                )
            }
        }
    }
}

private fun formatSize(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val units = arrayOf("KB", "MB", "GB", "TB")
    var value = bytes.toDouble()
    var unitIdx = -1
    while (value >= 1024 && unitIdx < units.lastIndex) {
        value /= 1024
        unitIdx++
    }
    return "%.1f %s".format(Locale.US, value, units[unitIdx])
}

private val mtimeFormat = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US)

private fun formatMtime(mtimeMs: Double): String {
    if (mtimeMs <= 0) return ""
    return mtimeFormat.format(Date(mtimeMs.toLong()))
}
