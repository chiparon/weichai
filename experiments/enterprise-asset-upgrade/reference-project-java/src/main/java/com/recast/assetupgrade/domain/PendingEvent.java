package com.recast.assetupgrade.domain;

import java.time.Instant;

public record PendingEvent(AssetEvent event, Instant retryAfter, int attempts, boolean retryable) {
    public PendingEvent {
        if (attempts < 0) throw new IllegalArgumentException("attempts cannot be negative");
        if (retryAfter == null) throw new NullPointerException("retryAfter");
    }

    public PendingEvent nextAttempt(Instant after) {
        return new PendingEvent(event.withState(WorkflowState.RETRY_PENDING), after, attempts + 1, retryable);
    }
}
