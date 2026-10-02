package com.recast.assetupgrade.domain;

import java.util.Arrays;
import java.util.Objects;

public record AttachmentInput(
        String attachmentId,
        String tenantId,
        String fileName,
        String declaredContentType,
        byte[] content,
        AttachmentState state) {
    public AttachmentInput {
        require(attachmentId, "attachmentId");
        require(tenantId, "tenantId");
        require(fileName, "fileName");
        require(declaredContentType, "declaredContentType");
        Objects.requireNonNull(content, "content");
        Objects.requireNonNull(state, "state");
        content = Arrays.copyOf(content, content.length);
    }

    @Override
    public byte[] content() {
        return Arrays.copyOf(content, content.length);
    }

    public boolean scanned() {
        return state == AttachmentState.SCANNED || state == AttachmentState.RELEASED;
    }

    private static void require(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
    }
}
