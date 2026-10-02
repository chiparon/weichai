package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.OrderRequest;
import com.recast.assetupgrade.domain.ReservationResult;
import com.recast.assetupgrade.port.OrderCommitter;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

public final class InMemoryOrderCommitter implements OrderCommitter {
    private final Map<String, ReservationResult> committed = new HashMap<>();
    private boolean failNextCommit;

    public void failNextCommit() { failNextCommit = true; }
    public int committedCount() { return committed.size(); }
    public boolean committed(String orderId) { return committed.containsKey(orderId); }

    @Override public synchronized CompletableFuture<Void> commit(OrderRequest order, ReservationResult reservation) {
        if (failNextCommit) { failNextCommit = false; return CompletableFuture.failedFuture(new IllegalStateException("commit failed")); }
        committed.put(order.orderId(), reservation);
        return CompletableFuture.completedFuture(null);
    }

    @Override public synchronized CompletableFuture<Void> rollback(String orderId) {
        committed.remove(orderId);
        return CompletableFuture.completedFuture(null);
    }
}
