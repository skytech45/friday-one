package com.friday.one.feature.files

import okhttp3.MediaType
import okhttp3.RequestBody
import okio.Buffer
import okio.BufferedSink
import okio.ForwardingSink
import okio.Sink
import okio.buffer

/**
 * Wraps a RequestBody to emit progress callbacks during upload.
 *
 * OkHttp writes through a BufferedSink; we intercept each flush to count
 * bytes sent without buffering the entire payload in memory.
 */
class ProgressRequestBody(
    private val delegate: RequestBody,
    private val totalBytes: Long,
    private val onProgress: (bytesSent: Long, totalBytes: Long) -> Unit,
) : RequestBody() {

    override fun contentType(): MediaType? = delegate.contentType()

    override fun contentLength(): Long = totalBytes

    override fun writeTo(sink: BufferedSink) {
        val countingSink = CountingSink(sink)
        val buffered = countingSink.buffer()
        delegate.writeTo(buffered)
        buffered.flush()
    }

    private inner class CountingSink(delegate: Sink) : ForwardingSink(delegate) {
        private var written = 0L

        override fun write(source: Buffer, byteCount: Long) {
            super.write(source, byteCount)
            written += byteCount
            onProgress(written, totalBytes)
        }
    }
}
