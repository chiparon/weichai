package com.recast.assetupgrade.port;

import com.recast.assetupgrade.domain.OrderRequest;
import com.recast.assetupgrade.domain.ReservationResult;
import java.util.concurrent.CompletableFuture;

public interface OrderCommitter {
    CompletableFuture<Void> commit(OrderRequest order, ReservationResult reservation);
    CompletableFuture<Void> rollback(String orderId);
}
