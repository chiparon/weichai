// C++ fixture — header half of a JNI bridge.
//
// Third of the three languages the 答题要求 names (JAVA/ArkTS/KMP/C/C++). Like the
// others it was registered in the language registry at the same `structural`
// capability level as Java with no fixture behind it, so "C/C++ support" had never
// been exercised on a real file.
//
// This header is written to exercise the two things C/C++ adds that the other
// languages do not have:
//   1. a declaration here and a definition in the .cpp, so the same class and the
//      same functions appear twice across two files;
//   2. `extern "C"` JNI exports whose names encode a Java class and whose parameter
//      types carry a JNI descriptor — the implicit dependency
//      cross-language-bindings.ts exists to recover.

#pragma once

#include <jni.h>

#include <cstddef>
#include <cstdint>
#include <string>

namespace upload {

/** Owns the file being written and the accounting around it. */
class ChunkWriter {
public:
    explicit ChunkWriter(std::string path);
    ~ChunkWriter();

    int32_t write(const uint8_t* data, std::size_t length);
    void flush();
    std::size_t written() const;

private:
    std::string path_;
    void* handle_ = nullptr;
    std::size_t written_ = 0;
};

int32_t open_session(const std::string& file_name);
void close_session(int32_t session);

}  // namespace upload

extern "C" {

JNIEXPORT jint JNICALL Java_com_example_upload_NativeUpload_beginUpload(JNIEnv* env, jobject thiz, jstring file_name);

JNIEXPORT jint JNICALL Java_com_example_upload_NativeUpload_pumpChunks(JNIEnv* env, jobject thiz, jint handle);

JNIEXPORT void JNICALL Java_com_example_upload_NativeUpload_endUpload(JNIEnv* env, jobject thiz, jint handle);

}
