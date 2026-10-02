package com.recast.assetupgrade.application;

import java.time.Instant;
import java.util.Map;

public record HealthReport(boolean healthy, Instant checkedAt, Map<String, String> components) {
    public HealthReport {
        if (checkedAt == null) throw new NullPointerException("checkedAt");
        components = Map.copyOf(components == null ? Map.of() : components);
    }
    public String status(String component) { return components.getOrDefault(component, "unknown"); }
}
