package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.OrderRequest;
import com.recast.assetupgrade.port.OrderRepository;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

public final class InMemoryOrderRepository implements OrderRepository {
    private final Map<String, OrderRequest> orders = new HashMap<>();
    @Override public synchronized Optional<OrderRequest> find(String tenantId, String orderId) { return Optional.ofNullable(orders.get(key(tenantId, orderId))); }
    @Override public synchronized void save(OrderRequest order) { orders.put(key(order.tenantId(), order.orderId()), order); }
    @Override public synchronized boolean exists(String tenantId, String orderId) { return orders.containsKey(key(tenantId, orderId)); }
    public synchronized int size() { return orders.size(); }
    private String key(String tenantId, String orderId) { return tenantId + "\u0000" + orderId; }
}
