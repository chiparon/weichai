package com.recast.assetupgrade.domain;

import java.time.Instant;
import java.util.Objects;

public record AssetEvent(
        String eventId,
        String tenantId,
        String assetId,
        String eventType,
        Instant createdAt,
        String attachmentId,
        WorkflowState state) {
    public AssetEvent {
        require(eventId, "eventId");
        require(tenantId, "tenantId");
        require(assetId, "assetId");
        require(eventType, "eventType");
        Objects.requireNonNull(createdAt, "createdAt");
        Objects.requireNonNull(state, "state");
    }

    public AssetEvent withState(WorkflowState next) {
        return new AssetEvent(eventId, tenantId, assetId, eventType, createdAt, attachmentId, next);
    }

    public boolean hasAttachment() {
        return attachmentId != null && !attachmentId.isBlank();
    }

    private static void require(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
    }
}
