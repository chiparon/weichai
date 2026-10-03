namespace AssetUpgradeGateway.Application;

using System.Diagnostics;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;

public sealed record WorkflowDeliveryCommand(string TenantId, string ActorId, AssetEvent Event, string CorrelationId);
public sealed record WorkflowDeliveryResult(bool Accepted, DeliveryStatus Status, WorkflowState State, int Attempts, IReadOnlyList<ValidationIssue> Issues);

public sealed class WorkflowDeliveryCoordinator
{
    private readonly ITenantAuthorizer authorizer;
    private readonly IWorkflowDispatcher dispatcher;
    private readonly IEventEnvelopeStore envelopes;
    private readonly IDispatchAttemptStore history;
    private readonly IDeadLetterSink deadLetters;
    private readonly IAuditSink audit;
    private readonly IMetricsSink metrics;
    private readonly IClock clock;
    private readonly IWorkflowStateMachine stateMachine;
    private readonly IRetryPolicy retryPolicy;
    private readonly DuplicateDeliveryPolicy duplicatePolicy = new();

    public WorkflowDeliveryCoordinator(ITenantAuthorizer authorizer, IWorkflowDispatcher dispatcher, IEventEnvelopeStore envelopes, IDispatchAttemptStore history, IDeadLetterSink deadLetters, IAuditSink audit, IMetricsSink metrics, IClock? clock = null, IWorkflowStateMachine? stateMachine = null, IRetryPolicy? retryPolicy = null)
    {
        this.authorizer = authorizer; this.dispatcher = dispatcher; this.envelopes = envelopes; this.history = history; this.deadLetters = deadLetters; this.audit = audit; this.metrics = metrics; this.clock = clock ?? new Adapters.SystemClock(); this.stateMachine = stateMachine ?? new WorkflowStateTransitionPolicy(); this.retryPolicy = retryPolicy ?? new ExponentialRetryPolicy();
    }

    public async Task<WorkflowDeliveryResult> DeliverAsync(WorkflowDeliveryCommand command, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(command.TenantId, command.ActorId)) return Deny(DeliveryStatus.Rejected, new("tenant.access.denied", "Actor cannot deliver for tenant.", ValidationSeverity.Error));
        if (command.Event.TenantId != command.TenantId) return Deny(DeliveryStatus.Rejected, new("event.tenant.mismatch", "Event belongs to another tenant.", ValidationSeverity.Error));
        var envelope = new EventEnvelope(command.Event, command.CorrelationId).WithHeader("actor", command.ActorId);
        var existing = await envelopes.FindAsync(command.TenantId, command.Event.EventId, cancellationToken);
        if (existing is not null) envelope = existing;
        var attempts = await history.FindAsync(command.TenantId, command.Event.EventId, cancellationToken);
        var duplicate = duplicatePolicy.Evaluate(attempts, command.Event);
        if (duplicate.Issues.Any(x => x.Code == "event.duplicate.completed")) return new(true, DeliveryStatus.Duplicate, WorkflowState.Completed, attempts.Count, duplicate.Issues);
        if (!stateMachine.CanTransition(command.Event.State, WorkflowState.Dispatched)) return Deny(DeliveryStatus.Rejected, new("event.state.invalid", "Event is not ready for dispatch.", ValidationSeverity.Error));
        var started = clock.UtcNow;
        var nextAttempt = attempts.Count + 1;
        envelope = envelope with { Stage = EventProcessingStage.Enqueued, DeliveryAttempt = nextAttempt, EnqueuedAt = started };
        await envelopes.SaveAsync(envelope, cancellationToken);
        var result = await dispatcher.DispatchAsync(command.Event.WithState(WorkflowState.Dispatched), cancellationToken);
        var finished = clock.UtcNow;
        await history.AppendAsync(new(command.TenantId, command.Event.EventId, nextAttempt, started, finished, result.Status, result.Detail), cancellationToken);
        if (result.Accepted)
        {
            await envelopes.SaveAsync(envelope.MarkDelivered(finished) with { Stage = EventProcessingStage.Completed }, cancellationToken);
            audit.Record(new(command.TenantId, command.Event.EventId, "workflow.deliver", "accepted", finished));
            metrics.Increment("workflow.delivered", command.TenantId);
            metrics.Timing("workflow.delivery.duration", command.TenantId, finished - started);
            return new(true, result.Status, WorkflowState.Completed, nextAttempt, []);
        }
        if (retryPolicy.CanRetry(nextAttempt))
        {
            var retryAt = retryPolicy.NextAttempt(finished, nextAttempt);
            await envelopes.SaveAsync(envelope with { Stage = EventProcessingStage.RetryScheduled, EnqueuedAt = retryAt }, cancellationToken);
            metrics.Increment("workflow.retry_scheduled", command.TenantId);
            return new(false, DeliveryStatus.Retryable, WorkflowState.RetryPending, nextAttempt, [new("event.retry.scheduled", $"Retry scheduled at {retryAt:O}.", ValidationSeverity.Warning)]);
        }
        await deadLetters.PublishAsync(new(command.Event, nextAttempt, result.Detail ?? "Delivery failed.", finished), cancellationToken);
        await envelopes.SaveAsync(envelope with { Stage = EventProcessingStage.DeadLettered }, cancellationToken);
        audit.Record(new(command.TenantId, command.Event.EventId, "workflow.dead_letter", "failed", finished));
        metrics.Increment("workflow.dead_lettered", command.TenantId);
        return new(false, DeliveryStatus.Rejected, WorkflowState.Failed, nextAttempt, [new("event.dead_lettered", "Delivery retry budget exhausted.", ValidationSeverity.Error)]);
    }

    private static WorkflowDeliveryResult Deny(DeliveryStatus status, ValidationIssue issue) => new(false, status, WorkflowState.Failed, 0, [issue]);
}

public sealed class WorkflowDeliveryQuery
{
    private readonly IDispatchAttemptStore history;
    private readonly ITenantAuthorizer authorizer;
    public WorkflowDeliveryQuery(IDispatchAttemptStore history, ITenantAuthorizer authorizer) { this.history = history; this.authorizer = authorizer; }
    public async Task<IReadOnlyList<DispatchAttempt>> GetAttemptsAsync(string tenantId, string actorId, string eventId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId)) throw new UnauthorizedAccessException("Actor cannot access tenant.");
        return await history.FindAsync(tenantId, eventId, cancellationToken);
    }
}

public sealed class WorkflowBatchDispatcher
{
    private readonly WorkflowDeliveryCoordinator coordinator;
    public WorkflowBatchDispatcher(WorkflowDeliveryCoordinator coordinator) => this.coordinator = coordinator;
    public async Task<IReadOnlyList<WorkflowDeliveryResult>> DispatchAsync(string tenantId, string actorId, IReadOnlyList<AssetEvent> events, string correlationId, CancellationToken cancellationToken = default)
    {
        var results = new List<WorkflowDeliveryResult>(events.Count);
        foreach (var item in events)
        {
            cancellationToken.ThrowIfCancellationRequested();
            results.Add(await coordinator.DeliverAsync(new(tenantId, actorId, item, correlationId), cancellationToken));
        }
        return results;
    }
}
