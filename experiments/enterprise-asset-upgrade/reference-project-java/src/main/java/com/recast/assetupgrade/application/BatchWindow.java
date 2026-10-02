package com.recast.assetupgrade.application;

import java.time.Instant;

public record BatchWindow(Instant from, Instant to, int limit) {
    public BatchWindow {
        if (from == null || to == null) throw new NullPointerException("window boundaries");
        if (to.isBefore(from)) throw new IllegalArgumentException("to must not precede from");
        if (limit <= 0) throw new IllegalArgumentException("limit must be positive");
    }

    public boolean contains(Instant value) { return !value.isBefore(from) && !value.isAfter(to); }
    public BatchWindow next(java.time.Duration duration) { return new BatchWindow(to, to.plus(duration), limit); }
}
