package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.port.FeatureFlags;
import java.util.HashSet;
import java.util.Set;

public final class InMemoryFeatureFlags implements FeatureFlags {
    private final Set<String> enabled = new HashSet<>();
    public void enable(String tenantId, String flag) { enabled.add(key(tenantId, flag)); }
    public void disable(String tenantId, String flag) { enabled.remove(key(tenantId, flag)); }
    @Override public boolean enabled(String tenantId, String flag) { return enabled.contains(key(tenantId, flag)); }
    private String key(String tenantId, String flag) { return tenantId + "\u0000" + flag; }
}
