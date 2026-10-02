package com.recast.assetupgrade.application;

import com.recast.assetupgrade.domain.OrderRequest;
import com.recast.assetupgrade.domain.OrderResult;
import com.recast.assetupgrade.domain.OrderTotals;
import com.recast.assetupgrade.port.AuditSink;
import com.recast.assetupgrade.port.Clock;
import com.recast.assetupgrade.port.OrderRepository;
import com.recast.assetupgrade.port.TenantAuthorizer;
import com.recast.assetupgrade.policy.OrderPolicy;
import com.recast.assetupgrade.policy.TenantPolicy;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

public final class OrderLifecycleService {
    private final TenantPolicy tenantPolicy;
    private final OrderPolicy orderPolicy;
    private final OrderRepository orders;
    private final AuditCoordinator audit;
    private final Clock clock;

    public OrderLifecycleService(TenantAuthorizer authorizer, OrderPolicy orderPolicy,
                                 OrderRepository orders, AuditSink audit, Clock clock) {
        this.tenantPolicy = new TenantPolicy(authorizer);
        this.orderPolicy = orderPolicy;
        this.orders = orders;
        this.audit = new AuditCoordinator(audit);
        this.clock = clock;
    }

    public Optional<String> validate(OrderRequest order) { return orderPolicy.validate(order); }

    public CompletableFuture<OrderResult> recordAccepted(OrderRequest order, String reservationId) {
        if (orders.exists(order.tenantId(), order.orderId())) {
            audit.duplicate(order.tenantId(), order.orderId(), "order.record", clock.now());
            return CompletableFuture.completedFuture(OrderResult.accepted(reservationId));
        }
        String access = tenantPolicy.validate(order.tenantId(), order.actorId(), "order.submit");
        if (access != null) return CompletableFuture.completedFuture(OrderResult.rejected(access));
        Optional<String> issue = orderPolicy.validate(order);
        if (issue.isPresent()) return CompletableFuture.completedFuture(OrderResult.rejected(issue.get()));
        orders.save(order);
        audit.accepted(order.tenantId(), order.orderId(), "order.record", clock.now());
        return CompletableFuture.completedFuture(OrderResult.accepted(reservationId));
    }

    public OrderTotals totals(OrderRequest order) { return OrderTotals.from(order.lines()); }
}
