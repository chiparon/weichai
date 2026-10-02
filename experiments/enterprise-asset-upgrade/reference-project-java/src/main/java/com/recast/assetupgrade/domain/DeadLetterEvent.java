package com.recast.assetupgrade.domain;

import java.time.Instant;

public record DeadLetterEvent(
        AssetEvent event,
        int attempts,
        String reason,
        Instant recordedAt) {
    public DeadLetterEvent {
        if (event == null) throw new NullPointerException("event");
        if (attempts < 0) throw new IllegalArgumentException("attempts cannot be negative");
        if (reason == null || reason.isBlank()) throw new IllegalArgumentException("reason is required");
        if (recordedAt == null) throw new NullPointerException("recordedAt");
    }
}
