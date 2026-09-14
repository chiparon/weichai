// Kotlin Multiplatform fixture — Android source set.
//
// Pairs with commonMain/UploadSession.kt through `actual` declarations. The point of
// including it is that the binding logic resolves expect/actual by matching a Kotlin
// declaration whose signature carries `expect` against the module's other Kotlin
// declarations, so the pair has to be indexed from two real files, not one snippet.

package com.example.upload

import java.io.RandomAccessFile

actual class UploadSink actual constructor(private val fileName: String) {
    private val file = RandomAccessFile(fileName, "rw")

    actual fun write(bytes: ByteArray): Int {
        file.write(bytes)
        return bytes.size
    }

    actual fun close() {
        file.close()
    }
}

actual fun platformTag(): String = "android"
