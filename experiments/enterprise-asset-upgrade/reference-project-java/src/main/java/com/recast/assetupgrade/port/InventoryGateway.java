package com.recast.assetupgrade.port;

import com.recast.assetupgrade.domain.OrderRequest;
import com.recast.assetupgrade.domain.ReservationResult;
import java.util.concurrent.CompletableFuture;

public interface InventoryGateway {
    CompletableFuture<ReservationResult> reserve(OrderRequest order);
    CompletableFuture<Void> release(String reservationId);
}
