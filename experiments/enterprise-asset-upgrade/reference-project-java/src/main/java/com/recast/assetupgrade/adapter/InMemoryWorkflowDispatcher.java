package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.AssetEvent;
import com.recast.assetupgrade.domain.DeliveryResult;
import com.recast.assetupgrade.port.WorkflowDispatcher;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

public final class InMemoryWorkflowDispatcher implements WorkflowDispatcher {
    private final Set<String> supportedTypes = new HashSet<>();
    private final Set<String> dispatched = new HashSet<>();
    private boolean failNext;

    public void support(String eventType) { supportedTypes.add(eventType); }
    public void failNext() { failNext = true; }
    public int dispatchedCount() { return dispatched.size(); }

    @Override public synchronized CompletableFuture<DeliveryResult> dispatch(AssetEvent event) {
        if (failNext) { failNext = false; return CompletableFuture.completedFuture(DeliveryResult.retryable("transport unavailable")); }
        if (!dispatched.add(event.tenantId() + "\u0000" + event.eventId())) {
            return CompletableFuture.completedFuture(DeliveryResult.duplicate("workflow event already dispatched"));
        }
        return CompletableFuture.completedFuture(DeliveryResult.accepted("workflow dispatched"));
    }

    @Override public synchronized boolean supports(String eventType) { return supportedTypes.contains(eventType); }
}
