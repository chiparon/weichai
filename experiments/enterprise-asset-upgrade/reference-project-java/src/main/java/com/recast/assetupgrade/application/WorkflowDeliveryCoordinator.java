package com.recast.assetupgrade.application;

import com.recast.assetupgrade.domain.AssetEvent;
import com.recast.assetupgrade.domain.DispatchAttempt;
import com.recast.assetupgrade.domain.DeliveryResult;
import com.recast.assetupgrade.port.Clock;
import com.recast.assetupgrade.port.DispatchHistory;
import com.recast.assetupgrade.port.MetricsSink;
import com.recast.assetupgrade.port.WorkflowDispatcher;
import java.time.Instant;
import java.util.concurrent.CompletableFuture;

public final class WorkflowDeliveryCoordinator {
    private final WorkflowDispatcher dispatcher;
    private final DispatchHistory history;
    private final MetricsSink metrics;
    private final Clock clock;

    public WorkflowDeliveryCoordinator(WorkflowDispatcher dispatcher, DispatchHistory history, MetricsSink metrics, Clock clock) {
        this.dispatcher = dispatcher;
        this.history = history;
        this.metrics = metrics;
        this.clock = clock;
    }

    public CompletableFuture<DeliveryResult> deliver(AssetEvent event, int attempt) {
        Instant started = clock.now();
        if (!dispatcher.supports(event.eventType())) {
            DeliveryResult result = DeliveryResult.rejected("unsupported event type");
            record(event, attempt, started, result);
            return CompletableFuture.completedFuture(result);
        }
        return dispatcher.dispatch(event).handle((result, error) -> {
            DeliveryResult actual = error == null ? result : DeliveryResult.retryable(message(error));
            record(event, attempt, started, actual);
            return actual;
        });
    }

    public java.util.List<DispatchAttempt> history(String tenantId, String eventId) { return history.find(tenantId, eventId); }

    private void record(AssetEvent event, int attempt, Instant started, DeliveryResult result) {
        Instant finished = clock.now();
        history.append(new DispatchAttempt(event.tenantId(), event.eventId(), Math.max(1, attempt), started, finished, result.status(), result.detail()));
        metrics.increment("workflow." + result.status().name().toLowerCase(), event.tenantId());
        metrics.timing("workflow.latency", event.tenantId(), java.time.Duration.between(started, finished));
    }

    private String message(Throwable error) {
        Throwable current = error;
        while (current.getCause() != null) current = current.getCause();
        return current.getMessage() == null ? current.getClass().getSimpleName() : current.getMessage();
    }
}
