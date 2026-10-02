package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.AttachmentInput;
import com.recast.assetupgrade.port.AttachmentQuarantine;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;

public final class DefaultAttachmentQuarantine implements AttachmentQuarantine {
    private static final Map<String, Set<String>> MAGIC = Map.of(
            "application/pdf", Set.of("%PDF-"),
            "text/plain", Set.of("text", "utf"),
            "application/octet-stream", Set.of("\u0000"));

    @Override public boolean isSafe(AttachmentInput attachment) {
        byte[] content = attachment.content();
        String prefix = new String(content, 0, Math.min(content.length, 8), StandardCharsets.UTF_8);
        if (attachment.declaredContentType().equals("application/octet-stream")) return true;
        return MAGIC.getOrDefault(attachment.declaredContentType(), Set.of()).stream().anyMatch(prefix::contains);
    }

    @Override public boolean isSupportedType(String declaredContentType) {
        return MAGIC.containsKey(declaredContentType);
    }

    @Override public boolean isSafeFileName(String fileName) {
        return !fileName.contains("..") && !fileName.contains("/") && !fileName.contains("\\") && !fileName.isBlank();
    }
}
