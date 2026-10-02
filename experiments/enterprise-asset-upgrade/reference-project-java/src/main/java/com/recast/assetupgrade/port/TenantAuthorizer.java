package com.recast.assetupgrade.port;

public interface TenantAuthorizer {
    boolean canAccess(String tenantId, String actorId);
    boolean canOperate(String tenantId, String actorId, String operation);
}
