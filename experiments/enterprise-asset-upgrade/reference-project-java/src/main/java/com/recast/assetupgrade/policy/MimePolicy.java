package com.recast.assetupgrade.policy;

import java.util.Map;
import java.util.Set;

public final class MimePolicy {
    private final Map<String, Set<String>> extensions = Map.of(
            "application/pdf", Set.of("pdf"),
            "text/plain", Set.of("txt", "log", "md"),
            "application/octet-stream", Set.of("bin", "dat"));

    public boolean supports(String mime) { return mime != null && extensions.containsKey(mime.toLowerCase()); }

    public boolean matchesExtension(String mime, String extension) {
        return supports(mime) && extension != null && extensions.get(mime.toLowerCase()).contains(extension.toLowerCase());
    }

    public Set<String> extensionsFor(String mime) {
        return extensions.getOrDefault(mime == null ? "" : mime.toLowerCase(), Set.of());
    }
}
