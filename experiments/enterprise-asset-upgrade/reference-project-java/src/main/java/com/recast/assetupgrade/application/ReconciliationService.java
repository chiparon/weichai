package com.recast.assetupgrade.application;

import com.recast.assetupgrade.domain.DeliveryResult;
import com.recast.assetupgrade.domain.PendingEvent;
import com.recast.assetupgrade.domain.ReconciliationReport;
import com.recast.assetupgrade.port.AuditSink;
import com.recast.assetupgrade.port.Clock;
import com.recast.assetupgrade.port.IdempotencyStore;
import com.recast.assetupgrade.port.RetryableEventStore;
import com.recast.assetupgrade.port.TenantAuthorizer;
import com.recast.assetupgrade.port.WorkflowDispatcher;
import com.recast.assetupgrade.policy.RetryPolicy;
import com.recast.assetupgrade.policy.TenantPolicy;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

public final class ReconciliationService {
    private final TenantPolicy tenantPolicy;
    private final RetryableEventStore eventStore;
    private final WorkflowDispatcher dispatcher;
    private final IdempotencyStore idempotency;
    private final AuditCoordinator audit;
    private final RetryPolicy retryPolicy;
    private final Clock clock;

    public ReconciliationService(
            TenantAuthorizer authorizer,
            RetryableEventStore eventStore,
            WorkflowDispatcher dispatcher,
            IdempotencyStore idempotency,
            AuditSink audit,
            RetryPolicy retryPolicy,
            Clock clock) {
        this.tenantPolicy = new TenantPolicy(authorizer);
        this.eventStore = eventStore;
        this.dispatcher = dispatcher;
        this.idempotency = idempotency;
        this.audit = new AuditCoordinator(audit);
        this.retryPolicy = retryPolicy;
        this.clock = clock;
    }

    public CompletableFuture<ReconciliationReport> run(String actorId, Instant now, int limit) {
        if (limit <= 0) return CompletableFuture.failedFuture(new IllegalArgumentException("limit must be positive"));
        return eventStore.findDue(now, limit).thenCompose(pending -> process(actorId, now, pending));
    }

    public boolean shouldRetry(PendingEvent pending) {
        return pending.retryable() && retryPolicy.canRetry(pending.attempts());
    }

    private CompletableFuture<ReconciliationReport> process(String actorId, Instant now, List<PendingEvent> pending) {
        List<String> ids = new ArrayList<>();
        Counters counters = new Counters();
        CompletableFuture<Void> chain = CompletableFuture.completedFuture(null);
        for (PendingEvent item : pending) {
            chain = chain.thenCompose(ignored -> processOne(actorId, now, item, counters, ids));
        }
        return chain.thenApply(ignored -> new ReconciliationReport(
                counters.examined, counters.retried, counters.succeeded, counters.failed, ids));
    }

    private CompletableFuture<Void> processOne(
            String actorId,
            Instant now,
            PendingEvent pending,
            Counters counters,
            List<String> ids) {
        counters.examined++;
        ids.add(pending.event().eventId());
        String tenantError = tenantPolicy.validate(pending.event().tenantId(), actorId, "asset.reconcile");
        if (tenantError != null) {
            counters.failed++;
            audit.rejected(pending.event().tenantId(), pending.event().eventId(), "asset.reconcile", tenantError, now);
            return CompletableFuture.completedFuture(null);
        }
        if (idempotency.hasCompleted(pending.event().tenantId(), pending.event().eventId())) {
            counters.succeeded++;
            return eventStore.remove(pending.event().tenantId(), pending.event().eventId());
        }
        if (!shouldRetry(pending)) {
            counters.failed++;
            audit.rejected(pending.event().tenantId(), pending.event().eventId(), "asset.reconcile", "retry limit reached", now);
            return CompletableFuture.completedFuture(null);
        }
        counters.retried++;
        return dispatcher.dispatch(pending.event())
                .thenCompose(result -> handleResult(pending, result, counters, now))
                .exceptionally(error -> {
                    counters.failed++;
                    audit.retryable(pending.event().tenantId(), pending.event().eventId(), "asset.reconcile", error.getMessage(), now);
                    return null;
                });
    }

    private CompletableFuture<Void> handleResult(PendingEvent pending, DeliveryResult result, Counters counters, Instant now) {
        if (result.accepted()) {
            idempotency.markCompleted(pending.event().tenantId(), pending.event().eventId());
            counters.succeeded++;
            audit.accepted(pending.event().tenantId(), pending.event().eventId(), "asset.reconcile", now);
            return eventStore.remove(pending.event().tenantId(), pending.event().eventId());
        }
        counters.failed++;
        PendingEvent next = pending.nextAttempt(retryPolicy.nextAttempt(now, pending.attempts()));
        audit.retryable(pending.event().tenantId(), pending.event().eventId(), "asset.reconcile", result.detail(), now);
        return eventStore.save(next);
    }

    private static final class Counters {
        private int examined;
        private int retried;
        private int succeeded;
        private int failed;
    }
}
