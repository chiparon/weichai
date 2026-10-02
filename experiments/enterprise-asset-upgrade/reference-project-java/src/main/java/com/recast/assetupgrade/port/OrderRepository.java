package com.recast.assetupgrade.port;

import com.recast.assetupgrade.domain.OrderRequest;
import java.util.Optional;

public interface OrderRepository {
    Optional<OrderRequest> find(String tenantId, String orderId);
    void save(OrderRequest order);
    boolean exists(String tenantId, String orderId);
}
