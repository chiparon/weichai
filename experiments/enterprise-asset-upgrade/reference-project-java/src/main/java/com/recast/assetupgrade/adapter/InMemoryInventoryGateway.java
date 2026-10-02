package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.OrderRequest;
import com.recast.assetupgrade.domain.ReservationResult;
import com.recast.assetupgrade.port.InventoryGateway;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

public final class InMemoryInventoryGateway implements InventoryGateway {
    private final Set<String> unavailable = new HashSet<>();
    private final Set<String> reservations = new HashSet<>();
    private boolean failRelease;

    public void markUnavailable(String sku) { unavailable.add(sku); }
    public void failNextRelease() { failRelease = true; }
    public int reservationCount() { return reservations.size(); }

    @Override public synchronized CompletableFuture<ReservationResult> reserve(OrderRequest order) {
        if (order.lines().stream().anyMatch(line -> unavailable.contains(line.sku()))) {
            return CompletableFuture.completedFuture(ReservationResult.failure("inventory unavailable"));
        }
        String id = "reservation:" + order.tenantId() + ":" + order.orderId();
        reservations.add(id);
        return CompletableFuture.completedFuture(ReservationResult.success(id));
    }

    @Override public synchronized CompletableFuture<Void> release(String reservationId) {
        if (failRelease) { failRelease = false; return CompletableFuture.failedFuture(new IllegalStateException("release failed")); }
        reservations.remove(reservationId);
        return CompletableFuture.completedFuture(null);
    }
}
