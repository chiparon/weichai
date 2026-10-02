package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.port.TenantAuthorizer;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

public final class InMemoryTenantAuthorizer implements TenantAuthorizer {
    private final Map<String, Set<String>> actors = new HashMap<>();
    private final Map<String, Set<String>> operations = new HashMap<>();

    public void allow(String tenantId, String actorId, String... allowedOperations) {
        actors.computeIfAbsent(tenantId, ignored -> new HashSet<>()).add(actorId);
        Set<String> permissions = operations.computeIfAbsent(actorId, ignored -> new HashSet<>());
        Set.of(allowedOperations).forEach(permissions::add);
    }

    @Override public boolean canAccess(String tenantId, String actorId) {
        return actors.getOrDefault(tenantId, Set.of()).contains(actorId);
    }

    @Override public boolean canOperate(String tenantId, String actorId, String operation) {
        return canAccess(tenantId, actorId) && operations.getOrDefault(actorId, Set.of()).contains(operation);
    }
}
