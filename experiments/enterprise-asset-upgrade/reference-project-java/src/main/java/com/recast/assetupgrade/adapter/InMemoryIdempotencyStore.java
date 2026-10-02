package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.port.IdempotencyStore;
import java.util.HashSet;
import java.util.Set;

public final class InMemoryIdempotencyStore implements IdempotencyStore {
    private final Set<String> claimed = new HashSet<>();
    private final Set<String> completed = new HashSet<>();

    @Override public synchronized boolean hasCompleted(String tenantId, String operationId) {
        return completed.contains(key(tenantId, operationId));
    }

    @Override public synchronized boolean claim(String tenantId, String operationId) {
        return claimed.add(key(tenantId, operationId));
    }

    @Override public synchronized void markCompleted(String tenantId, String operationId) {
        String key = key(tenantId, operationId);
        claimed.add(key);
        completed.add(key);
    }

    @Override public synchronized void release(String tenantId, String operationId) {
        claimed.remove(key(tenantId, operationId));
    }

    public synchronized int completedCount() { return completed.size(); }
    private String key(String tenantId, String operationId) { return tenantId + "\u0000" + operationId; }
}
