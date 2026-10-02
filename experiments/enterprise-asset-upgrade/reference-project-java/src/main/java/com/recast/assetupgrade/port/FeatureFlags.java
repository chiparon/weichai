package com.recast.assetupgrade.port;

public interface FeatureFlags {
    boolean enabled(String tenantId, String flag);
}
