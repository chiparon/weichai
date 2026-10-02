package com.recast.assetupgrade.application;

import com.recast.assetupgrade.domain.OrderRequest;
import com.recast.assetupgrade.domain.OrderResult;
import com.recast.assetupgrade.domain.ReservationResult;
import com.recast.assetupgrade.port.AuditSink;
import com.recast.assetupgrade.port.Clock;
import com.recast.assetupgrade.port.IdempotencyStore;
import com.recast.assetupgrade.port.InventoryGateway;
import com.recast.assetupgrade.port.OrderCommitter;
import com.recast.assetupgrade.port.OrderValidator;
import com.recast.assetupgrade.port.TenantAuthorizer;
import com.recast.assetupgrade.policy.OrderPolicy;
import com.recast.assetupgrade.policy.TenantPolicy;
import java.time.Instant;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

public final class OrderPluginBridge {
    private final TenantPolicy tenantPolicy;
    private final OrderPolicy orderPolicy;
    private final InventoryGateway inventory;
    private final IdempotencyStore idempotency;
    private final OrderCommitter committer;
    private final AuditCoordinator audit;
    private final Clock clock;

    public OrderPluginBridge(
            TenantAuthorizer authorizer,
            OrderValidator validator,
            InventoryGateway inventory,
            IdempotencyStore idempotency,
            OrderCommitter committer,
            AuditSink audit,
            Clock clock) {
        this.tenantPolicy = new TenantPolicy(authorizer);
        this.orderPolicy = new OrderPolicy(validator);
        this.inventory = inventory;
        this.idempotency = idempotency;
        this.committer = committer;
        this.audit = new AuditCoordinator(audit);
        this.clock = clock;
    }

    public CompletableFuture<OrderResult> submit(OrderRequest order) {
        Instant now = clock.now();
        String tenantError = tenantPolicy.validate(order.tenantId(), order.actorId(), "order.submit");
        if (tenantError != null) return rejected(order, tenantError, now);
        Optional<String> invalid = orderPolicy.validate(order);
        if (invalid.isPresent()) return rejected(order, invalid.get(), now);
        if (idempotency.hasCompleted(order.tenantId(), order.orderId())) {
            audit.duplicate(order.tenantId(), order.orderId(), "order.submit", now);
            return CompletableFuture.completedFuture(OrderResult.accepted("existing:" + order.orderId()));
        }
        if (!idempotency.claim(order.tenantId(), order.orderId())) {
            audit.duplicate(order.tenantId(), order.orderId(), "order.submit", now);
            return CompletableFuture.completedFuture(OrderResult.rejected("order is already being processed"));
        }
        return inventory.reserve(order)
                .thenCompose(reservation -> commit(order, reservation, now))
                .exceptionally(error -> {
                    idempotency.release(order.tenantId(), order.orderId());
                    audit.rejected(order.tenantId(), order.orderId(), "order.submit", message(error), clock.now());
                    return OrderResult.rolledBack(message(error));
                });
    }

    public long total(OrderRequest order) {
        return order.totalMinor();
    }

    private CompletableFuture<OrderResult> commit(OrderRequest order, ReservationResult reservation, Instant now) {
        if (!reservation.reserved()) {
            idempotency.release(order.tenantId(), order.orderId());
            audit.rejected(order.tenantId(), order.orderId(), "order.submit", reservation.detail(), now);
            return CompletableFuture.completedFuture(OrderResult.rejected(reservation.detail()));
        }
        return committer.commit(order, reservation)
                .thenApply(ignored -> {
                    idempotency.markCompleted(order.tenantId(), order.orderId());
                    audit.accepted(order.tenantId(), order.orderId(), "order.submit", clock.now());
                    return OrderResult.accepted(reservation.reservationId());
                })
                .exceptionally(error -> {
                    inventory.release(reservation.reservationId()).join();
                    idempotency.release(order.tenantId(), order.orderId());
                    audit.rejected(order.tenantId(), order.orderId(), "order.submit", message(error), clock.now());
                    return OrderResult.rolledBack(message(error));
                });
    }

    private CompletableFuture<OrderResult> rejected(OrderRequest order, String reason, Instant now) {
        audit.rejected(order.tenantId(), order.orderId(), "order.submit", reason, now);
        return CompletableFuture.completedFuture(OrderResult.rejected(reason));
    }

    private String message(Throwable error) {
        Throwable current = error;
        while (current.getCause() != null) current = current.getCause();
        return current.getMessage() == null ? current.getClass().getSimpleName() : current.getMessage();
    }
}
