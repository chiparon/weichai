package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.AssetEvent;
import com.recast.assetupgrade.domain.DeliveryResult;
import com.recast.assetupgrade.port.WorkflowDispatcher;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/** Dispatcher fixture that models an external queue with scripted responses. */
public final class ConfigurableWorkflowDispatcher implements WorkflowDispatcher {
    private final Set<String> supported = new HashSet<>();
    private final Queue<DeliveryResult> scripted = new ArrayDeque<>();
    private final Set<String> delivered = new HashSet<>();
    private boolean throwNext;

    public synchronized ConfigurableWorkflowDispatcher support(String eventType) { supported.add(eventType); return this; }
    public synchronized ConfigurableWorkflowDispatcher respond(DeliveryResult result) { scripted.add(result); return this; }
    public synchronized void throwNext() { throwNext = true; }
    public synchronized int deliveredCount() { return delivered.size(); }
    public synchronized boolean supports(String eventType) { return supported.contains(eventType); }

    @Override public synchronized CompletableFuture<DeliveryResult> dispatch(AssetEvent event) {
        if (!supports(event.eventType())) return CompletableFuture.completedFuture(DeliveryResult.rejected("unsupported event type"));
        if (throwNext) { throwNext = false; return CompletableFuture.failedFuture(new IllegalStateException("queue unavailable")); }
        String key = event.tenantId() + "\u0000" + event.eventId();
        DeliveryResult result = scripted.poll();
        if (result != null) return result.accepted() ? mark(key, result) : CompletableFuture.completedFuture(result);
        return delivered.add(key) ? CompletableFuture.completedFuture(DeliveryResult.accepted("queued"))
                : CompletableFuture.completedFuture(DeliveryResult.duplicate("already queued"));
    }

    private CompletableFuture<DeliveryResult> mark(String key, DeliveryResult result) {
        delivered.add(key);
        return CompletableFuture.completedFuture(result);
    }
}
