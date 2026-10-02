package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.port.MetricsSink;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;

public final class InMemoryMetricsSink implements MetricsSink {
    private final Map<String, Map<String, Long>> counters = new HashMap<>();
    private final Map<String, Long> timings = new HashMap<>();
    @Override public synchronized void increment(String name, String tenantId) {
        counters.computeIfAbsent(tenantId, ignored -> new HashMap<>()).merge(name, 1L, Long::sum);
    }
    @Override public synchronized void timing(String name, String tenantId, Duration duration) {
        timings.merge(tenantId + "\u0000" + name, duration.toMillis(), Long::sum);
    }
    @Override public synchronized Map<String, Long> counters(String tenantId) {
        return Map.copyOf(counters.getOrDefault(tenantId, Map.of()));
    }
    public synchronized long totalTimingMillis(String tenantId, String name) { return timings.getOrDefault(tenantId + "\u0000" + name, 0L); }
}
