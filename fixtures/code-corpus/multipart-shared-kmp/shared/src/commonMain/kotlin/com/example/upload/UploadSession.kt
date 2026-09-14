// Kotlin Multiplatform fixture — common source set.
//
// Same reasoning as the ArkTS fixture: the registry lists `kotlin` (.kt/.kts) at the
// same `structural` capability level as Java and cross-language-bindings.ts already
// resolves expect/actual pairs, but fixtures/code-corpus had no Kotlin file at all,
// so KMP support was registered, untested and unmeasured.
//
// The constructs here are the ones the binding logic keys on (`expect` declarations)
// plus the Kotlin surface the extractor has to survive: suspend functions, default
// arguments, companion objects, enum/data classes, property accessors and an
// interface.

package com.example.upload

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** Platform upload primitive; each target supplies its own implementation. */
expect class UploadSink(fileName: String) {
    fun write(bytes: ByteArray): Int
    fun close()
}

expect fun platformTag(): String

internal data class UploadProgress(val sent: Long, val total: Long) {
    val percent: Int get() = if (total <= 0L) 0 else ((sent * 100) / total).toInt()
}

enum class UploadState { PENDING, RUNNING, DONE, FAILED }

interface UploadListener {
    fun onProgress(progress: UploadProgress)
    fun onFailure(error: Throwable)
}

open class UploadSession(private val fileName: String) {
    private val sink = UploadSink(fileName)
    var state: UploadState = UploadState.PENDING
        private set

    suspend fun transfer(source: File, listener: UploadListener? = null) {
        state = UploadState.RUNNING
        try {
            withContext(Dispatchers.IO) {
                val bytes = source.readBytes()
                val sent = sink.write(bytes)
                listener?.onProgress(UploadProgress(sent.toLong(), bytes.size.toLong()))
            }
            state = UploadState.DONE
        } catch (error: Throwable) {
            state = UploadState.FAILED
            listener?.onFailure(error)
        } finally {
            sink.close()
        }
    }

    companion object {
        const val MAX_CHUNK: Int = 64 * 1024
        fun describe(): String = "upload:$fileName#${platformTag()}"
    }
}
