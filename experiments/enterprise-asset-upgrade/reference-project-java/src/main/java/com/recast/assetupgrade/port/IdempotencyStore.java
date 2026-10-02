package com.recast.assetupgrade.port;

public interface IdempotencyStore {
    boolean hasCompleted(String tenantId, String operationId);
    boolean claim(String tenantId, String operationId);
    void markCompleted(String tenantId, String operationId);
    void release(String tenantId, String operationId);
}
