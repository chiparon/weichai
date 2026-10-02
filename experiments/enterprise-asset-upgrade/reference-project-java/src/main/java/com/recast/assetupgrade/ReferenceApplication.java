package com.recast.assetupgrade;

import com.recast.assetupgrade.adapter.*;
import com.recast.assetupgrade.application.*;
import com.recast.assetupgrade.policy.AttachmentValidationPolicy;
import com.recast.assetupgrade.policy.OrderPolicy;
import com.recast.assetupgrade.policy.RetryPolicy;
import java.time.Duration;
import java.time.Instant;

/** Composition root used by examples and hidden evaluator tests. */
public final class ReferenceApplication {
    public final InMemoryClock clock;
    public final InMemoryTenantAuthorizer authorizer;
    public final InMemoryAuditSink audit;
    public final InMemoryIdempotencyStore idempotency;
    public final InMemoryWorkflowDispatcher dispatcher;
    public final InMemoryRetryableEventStore retryStore;
    public final InMemoryInventoryGateway inventory;
    public final InMemoryOrderCommitter committer;
    public final InMemoryAttachmentRepository attachments;
    public final InMemoryAttachmentScanner scanner;
    public final InMemoryMetricsSink metrics;
    public final InMemoryDispatchHistory dispatchHistory;
    public final InMemoryDeadLetterSink deadLetters;
    public final InMemoryOrderRepository orders;
    public final InMemoryFeatureFlags flags;
    public final AssetUpgradeService assetUpgrade;
    public final AttachmentIntakeService attachmentIntake;
    public final ReconciliationService reconciliation;
    public final ReconciliationOrchestrator reconciliationOrchestrator;
    public final OrderPluginBridge orderBridge;
    public final OrderLifecycleService orderLifecycle;
    public final WorkflowDeliveryCoordinator workflowDelivery;
    public final ReferenceHealthService health;

    private ReferenceApplication() {
        clock = new InMemoryClock(Instant.parse("2026-01-01T00:00:00Z"));
        authorizer = new InMemoryTenantAuthorizer();
        audit = new InMemoryAuditSink();
        idempotency = new InMemoryIdempotencyStore();
        dispatcher = new InMemoryWorkflowDispatcher();
        retryStore = new InMemoryRetryableEventStore();
        inventory = new InMemoryInventoryGateway();
        committer = new InMemoryOrderCommitter();
        attachments = new InMemoryAttachmentRepository();
        scanner = new InMemoryAttachmentScanner();
        metrics = new InMemoryMetricsSink();
        dispatchHistory = new InMemoryDispatchHistory();
        deadLetters = new InMemoryDeadLetterSink();
        orders = new InMemoryOrderRepository();
        flags = new InMemoryFeatureFlags();
        dispatcher.support("asset.created");
        dispatcher.support("asset.updated");
        authorizer.allow("tenant-a", "operator", "asset.submit", "asset.reconcile", "asset.attachment", "order.submit");
        authorizer.allow("tenant-b", "operator-b", "asset.submit", "asset.reconcile", "asset.attachment", "order.submit");
        assetUpgrade = new AssetUpgradeService(authorizer, new DefaultAttachmentQuarantine(), dispatcher, idempotency, audit, clock);
        attachmentIntake = new AttachmentIntakeService(authorizer, new AttachmentValidationPolicy(new DefaultAttachmentQuarantine()), attachments, scanner, audit, clock);
        RetryPolicy retries = new RetryPolicy(4, Duration.ofSeconds(5));
        reconciliation = new ReconciliationService(authorizer, retryStore, dispatcher, idempotency, audit, retries, clock);
        reconciliationOrchestrator = new ReconciliationOrchestrator(reconciliation, retryStore, deadLetters, retries);
        orderBridge = new OrderPluginBridge(authorizer, new DefaultOrderValidator(), inventory, idempotency, committer, audit, clock);
        orderLifecycle = new OrderLifecycleService(authorizer, new OrderPolicy(new DefaultOrderValidator()), orders, audit, clock);
        workflowDelivery = new WorkflowDeliveryCoordinator(dispatcher, dispatchHistory, metrics, clock);
        health = new ReferenceHealthService(clock, flags);
    }

    public static ReferenceApplication create() { return new ReferenceApplication(); }
}
