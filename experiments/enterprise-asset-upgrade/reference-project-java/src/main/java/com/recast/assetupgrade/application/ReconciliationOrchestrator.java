package com.recast.assetupgrade.application;

import com.recast.assetupgrade.domain.PendingEvent;
import com.recast.assetupgrade.domain.ReconciliationReport;
import com.recast.assetupgrade.port.DeadLetterSink;
import com.recast.assetupgrade.port.RetryableEventStore;
import com.recast.assetupgrade.policy.RetryDecision;
import com.recast.assetupgrade.policy.RetryPolicy;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/** Adds dead-letter handling and per-tenant filtering around the core reconciliation service. */
public final class ReconciliationOrchestrator {
    private final ReconciliationService service;
    private final RetryableEventStore store;
    private final DeadLetterSink deadLetters;
    private final RetryPolicy retryPolicy;

    public ReconciliationOrchestrator(ReconciliationService service, RetryableEventStore store,
                                      DeadLetterSink deadLetters, RetryPolicy retryPolicy) {
        this.service = service;
        this.store = store;
        this.deadLetters = deadLetters;
        this.retryPolicy = retryPolicy;
    }

    public CompletableFuture<ReconciliationReport> run(String actorId, Instant now, int limit) {
        return store.findDue(now, limit).thenCompose(items -> {
            List<PendingEvent> eligible = new ArrayList<>();
            for (PendingEvent item : items) {
                RetryDecision decision = RetryDecision.decide(item, retryPolicy, now);
                if (decision.deadLetter()) {
                    deadLetters.publish(new com.recast.assetupgrade.domain.DeadLetterEvent(item.event(), item.attempts(), decision.reason(), now));
                    store.remove(item.event().tenantId(), item.event().eventId());
                } else if (decision.retry()) {
                    eligible.add(item);
                }
            }
            return eligible.isEmpty()
                    ? CompletableFuture.completedFuture(new ReconciliationReport(0, 0, 0, 0, List.of()))
                    : service.run(actorId, now, eligible.size());
        });
    }

    public List<com.recast.assetupgrade.domain.DeadLetterEvent> deadLetters(String tenantId) {
        return deadLetters.findForTenant(tenantId);
    }
}
