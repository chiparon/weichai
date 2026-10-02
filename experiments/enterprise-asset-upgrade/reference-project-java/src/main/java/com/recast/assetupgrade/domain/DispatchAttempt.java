package com.recast.assetupgrade.domain;

import java.time.Instant;

public record DispatchAttempt(
        String tenantId,
        String eventId,
        int attempt,
        Instant startedAt,
        Instant finishedAt,
        DeliveryStatus status,
        String detail) {
    public DispatchAttempt {
        if (tenantId == null || tenantId.isBlank()) throw new IllegalArgumentException("tenantId is required");
        if (eventId == null || eventId.isBlank()) throw new IllegalArgumentException("eventId is required");
        if (attempt < 1) throw new IllegalArgumentException("attempt must be positive");
        if (startedAt == null || finishedAt == null) throw new NullPointerException("attempt timestamps");
        if (status == null) throw new NullPointerException("status");
    }

    public long durationMillis() {
        return Math.max(0, finishedAt.toEpochMilli() - startedAt.toEpochMilli());
    }
}
