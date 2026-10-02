package com.recast.assetupgrade.policy;

import com.recast.assetupgrade.port.TenantAuthorizer;

public final class TenantPolicy {
    private final TenantAuthorizer authorizer;

    public TenantPolicy(TenantAuthorizer authorizer) {
        this.authorizer = authorizer;
    }

    public String validate(String tenantId, String actorId, String operation) {
        if (tenantId == null || tenantId.isBlank()) return "tenant is required";
        if (actorId == null || actorId.isBlank()) return "actor is required";
        if (!authorizer.canAccess(tenantId, actorId)) return "actor cannot access tenant";
        if (!authorizer.canOperate(tenantId, actorId, operation)) return "actor cannot perform operation";
        return null;
    }

    public boolean canRead(String tenantId, String actorId) {
        return authorizer.canAccess(tenantId, actorId);
    }
}
