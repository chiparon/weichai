package com.recast.assetupgrade.policy;

import java.time.Duration;
import java.time.Instant;

public final class RetryPolicy {
    private final int maxAttempts;
    private final Duration baseDelay;

    public RetryPolicy(int maxAttempts, Duration baseDelay) {
        if (maxAttempts < 1) throw new IllegalArgumentException("maxAttempts must be positive");
        if (baseDelay.isNegative() || baseDelay.isZero()) throw new IllegalArgumentException("baseDelay must be positive");
        this.maxAttempts = maxAttempts;
        this.baseDelay = baseDelay;
    }

    public boolean canRetry(int attempts) {
        return attempts < maxAttempts;
    }

    public Instant nextAttempt(Instant now, int attempts) {
        long multiplier = 1L << Math.min(attempts, 20);
        return now.plus(baseDelay.multipliedBy(multiplier));
    }

    public int maxAttempts() { return maxAttempts; }
    public Duration baseDelay() { return baseDelay; }
}
