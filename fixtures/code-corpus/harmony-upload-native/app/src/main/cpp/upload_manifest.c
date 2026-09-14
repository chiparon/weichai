// C fixture — the plain-C half of the native bridge's session bookkeeping.
//
// The other two files in this directory are a C++ pair. `.h` is read with the C++
// grammar on purpose (see `grammarsByExtension` in language-registry.ts) while
// `.c` is read with the C grammar, and the two grammars spell a body-less
// declaration the same way: a `declaration` node holding a declarator. That node
// type was absent from the indexer's node-type map, so no prototype in either
// language reached the index — the header's `extern "C"` JNI exports were
// missing even though the .cpp's definitions were found.
//
// This file is the C-grammar half of that measurement, and it is the only
// fixture that declares a function *pointer* member. `int (*on_chunk)(...)`
// contains a function declarator without declaring a function, so a rule that
// keys on "contains a function declarator" alone would report it as a method.

#include <stddef.h>

typedef struct upload_manifest {
    const char* file_name;
    size_t expected_bytes;
    int (*on_chunk)(size_t chunk_bytes);
} upload_manifest;

// The interface half of this translation unit: prototypes, no bodies.
upload_manifest* upload_manifest_open(const char* file_name, size_t expected_bytes);
int upload_manifest_close(upload_manifest* manifest);
size_t upload_manifest_written(const upload_manifest* manifest);

// File-scope state, which is a declaration site rather than a local.
static size_t g_manifests_open;

static void upload_manifest_touch(upload_manifest* manifest) {
    // A local: `declaration` too, but not part of this file's interface.
    size_t header_bytes = sizeof(upload_manifest);
    manifest->expected_bytes += header_bytes - header_bytes;
    g_manifests_open += 1;
}

int upload_manifest_close(upload_manifest* manifest) {
    if (manifest == NULL) {
        return -1;
    }
    upload_manifest_touch(manifest);
    return 0;
}
