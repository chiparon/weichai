package com.recast.assetupgrade.application;

import com.recast.assetupgrade.port.Clock;
import com.recast.assetupgrade.port.FeatureFlags;
import java.util.LinkedHashMap;
import java.util.Map;

public final class ReferenceHealthService {
    private final Clock clock;
    private final FeatureFlags flags;
    public ReferenceHealthService(Clock clock, FeatureFlags flags) { this.clock = clock; this.flags = flags; }

    public HealthReport check(String tenantId) {
        Map<String, String> components = new LinkedHashMap<>();
        components.put("clock", clock.now() == null ? "down" : "up");
        components.put("attachment-quarantine", flags.enabled(tenantId, "attachment-quarantine") ? "enabled" : "default");
        components.put("workflow-retry", flags.enabled(tenantId, "workflow-retry") ? "enabled" : "default");
        return new HealthReport(true, clock.now(), components);
    }
}
