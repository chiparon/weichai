// C++ fixture — implementation half of the JNI bridge declared in upload_bridge.h.
//
// The definitions below repeat the header's class and functions, which is what makes
// this fixture worth having: the index has to hold two declaration sites for one
// symbol, and `cross-language-bindings.ts` has to connect the JNI export names here
// to the Java declarations they implement.

#include "upload_bridge.h"

#include <fstream>
#include <unordered_map>
#include <vector>

namespace {

std::unordered_map<int32_t, upload::ChunkWriter*> g_sessions;
int32_t g_next = 1;

}  // namespace

namespace upload {

ChunkWriter::ChunkWriter(std::string path) : path_(std::move(path)), handle_(nullptr), written_(0) {
    handle_ = std::fopen(path_.c_str(), "wb");
}

ChunkWriter::~ChunkWriter() { flush(); }

int32_t ChunkWriter::write(const uint8_t* data, std::size_t length) {
    if (handle_ == nullptr) {
        return -1;
    }
    const std::size_t written = std::fwrite(data, 1, length, static_cast<std::FILE*>(handle_));
    written_ += written;
    return static_cast<int32_t>(written);
}

void ChunkWriter::flush() {
    if (handle_ != nullptr) {
        std::fclose(static_cast<std::FILE*>(handle_));
        handle_ = nullptr;
    }
}

std::size_t ChunkWriter::written() const { return written_; }

int32_t open_session(const std::string& file_name) {
    if (file_name.empty()) {
        return -1;
    }
    const int32_t handle = g_next++;
    g_sessions[handle] = new ChunkWriter(file_name);
    return handle;
}

void close_session(int32_t session) {
    const auto found = g_sessions.find(session);
    if (found == g_sessions.end()) {
        return;
    }
    delete found->second;
    g_sessions.erase(found);
}

}  // namespace upload

extern "C" {

JNIEXPORT jint JNICALL Java_com_example_upload_NativeUpload_beginUpload(JNIEnv* env, jobject thiz, jstring file_name) {
    const char* utf8 = env->GetStringUTFChars(file_name, nullptr);
    const int32_t handle = upload::open_session(std::string(utf8 == nullptr ? "" : utf8));
    env->ReleaseStringUTFChars(file_name, utf8);
    return handle;
}

JNIEXPORT jint JNICALL Java_com_example_upload_NativeUpload_pumpChunks(JNIEnv* env, jobject thiz, jint handle) {
    const auto found = g_sessions.find(handle);
    if (found == g_sessions.end()) {
        return -1;
    }
    return static_cast<jint>(found->second->written());
}

JNIEXPORT void JNICALL Java_com_example_upload_NativeUpload_endUpload(JNIEnv* env, jobject thiz, jint handle) {
    upload::close_session(handle);
}

}
