package com.recast.assetupgrade.port;

import java.time.Duration;
import java.util.Map;

public interface MetricsSink {
    void increment(String name, String tenantId);
    void timing(String name, String tenantId, Duration duration);
    Map<String, Long> counters(String tenantId);
}
