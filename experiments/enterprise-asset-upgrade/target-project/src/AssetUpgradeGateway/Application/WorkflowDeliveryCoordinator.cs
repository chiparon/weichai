namespace AssetUpgradeGateway.Application;

using System.Diagnostics;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
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
        ArgumentNullException.ThrowIfNull(command);
        cancellationToken.ThrowIfCancellationRequested();

        var tenantId = command.TenantId;
        var eventId = command.Event.EventId;

        if (!authorizer.CanAccess(tenantId, command.ActorId))
        {
            return Deny(DeliveryStatus.Rejected, new ValidationIssue("workflow.tenant.forbidden", "Actor is not authorized for the tenant.", ValidationSeverity.Error));
        }

        var envelope = await envelopes.FindAsync(tenantId, eventId, cancellationToken).ConfigureAwait(false)
            ?? new EventEnvelope(command.Event, command.CorrelationId);

        var attempts = await history.FindAsync(tenantId, eventId, cancellationToken).ConfigureAwait(false);
        var duplicate = duplicatePolicy.Evaluate(attempts, command.Event);
        if (!duplicate.Allowed)
        {
            var issue = duplicate.Issues.Count > 0
                ? duplicate.Issues[0]
                : new ValidationIssue("workflow.duplicate", "Event was already delivered.", ValidationSeverity.Warning);
            audit.Record(new AuditRecord(tenantId, eventId, "workflow.duplicate", "duplicate", clock.UtcNow));
            return Deny(DeliveryStatus.Duplicate, issue);
        }

        var attemptNumber = attempts.Count + 1;
        var started = clock.UtcNow;
        var stopwatch = Stopwatch.StartNew();
        var outcome = await dispatcher.DispatchAsync(command.Event, cancellationToken).ConfigureAwait(false);
        stopwatch.Stop();
        var finished = clock.UtcNow;

        await history.AppendAsync(new DispatchAttempt(tenantId, eventId, attemptNumber, started, finished, outcome.Status, outcome.Detail), cancellationToken).ConfigureAwait(false);
        metrics.Increment("workflow.delivery.attempts", tenantId);
        metrics.Timing("workflow.delivery", tenantId, stopwatch.Elapsed);

        if (outcome.Status == DeliveryStatus.Accepted)
        {
            var delivered = envelope.MarkDelivered(clock.UtcNow);
            await envelopes.SaveAsync(delivered, cancellationToken).ConfigureAwait(false);
            audit.Record(new AuditRecord(tenantId, eventId, "workflow.delivered", WorkflowState.Completed.ToString().ToLowerInvariant(), clock.UtcNow));
            return new WorkflowDeliveryResult(true, DeliveryStatus.Accepted, WorkflowState.Completed, attemptNumber, Array.Empty<ValidationIssue>());
        }

        if (outcome.Status == DeliveryStatus.Retryable)
        {
            if (retryPolicy.CanRetry(attemptNumber))
            {
                var scheduled = envelope.NextAttempt(clock.UtcNow);
                await envelopes.SaveAsync(scheduled, cancellationToken).ConfigureAwait(false);
                var retryIssue = new ValidationIssue("workflow.retry", outcome.Detail ?? "Delivery failed and was scheduled for retry.", ValidationSeverity.Warning);
                audit.Record(new AuditRecord(tenantId, eventId, "workflow.retry", WorkflowState.RetryPending.ToString().ToLowerInvariant(), clock.UtcNow));
                return new WorkflowDeliveryResult(false, DeliveryStatus.Retryable, WorkflowState.RetryPending, attemptNumber, new[] { retryIssue });
            }

            await deadLetters.PublishAsync(new DeadLetterEvent(command.Event, attemptNumber, outcome.Detail ?? "Retry budget exhausted.", clock.UtcNow), cancellationToken).ConfigureAwait(false);
            var deadIssue = new ValidationIssue("workflow.deadletter", outcome.Detail ?? "Delivery failed permanently.", ValidationSeverity.Error);
            audit.Record(new AuditRecord(tenantId, eventId, "workflow.deadlettered", WorkflowState.Failed.ToString().ToLowerInvariant(), clock.UtcNow));
            return new WorkflowDeliveryResult(false, DeliveryStatus.Rejected, WorkflowState.Failed, attemptNumber, new[] { deadIssue });
        }

        if (outcome.Status == DeliveryStatus.Duplicate)
        {
            var duplicateIssue = new ValidationIssue("workflow.duplicate", outcome.Detail ?? "Delivery was reported as a duplicate.", ValidationSeverity.Warning);
            audit.Record(new AuditRecord(tenantId, eventId, "workflow.duplicate", WorkflowState.Completed.ToString().ToLowerInvariant(), clock.UtcNow));
            return new WorkflowDeliveryResult(false, DeliveryStatus.Duplicate, WorkflowState.Completed, attemptNumber, new[] { duplicateIssue });
        }

        var reason = outcome.Detail ?? $"Delivery {outcome.Status}.";
        await deadLetters.PublishAsync(new DeadLetterEvent(command.Event, attemptNumber, reason, clock.UtcNow), cancellationToken).ConfigureAwait(false);
        var terminal = new ValidationIssue("workflow.rejected", reason, ValidationSeverity.Error);
        audit.Record(new AuditRecord(tenantId, eventId, "workflow.deadlettered", WorkflowState.Failed.ToString().ToLowerInvariant(), clock.UtcNow));
        return new WorkflowDeliveryResult(false, outcome.Status, WorkflowState.Failed, attemptNumber, new[] { terminal });
    }

    private static WorkflowDeliveryResult Deny(DeliveryStatus status, ValidationIssue issue)
    {
        var state = status switch
        {
            DeliveryStatus.Duplicate => WorkflowState.Completed,
            DeliveryStatus.Retryable => WorkflowState.RetryPending,
            _ => WorkflowState.Failed,
        };
        return new WorkflowDeliveryResult(false, status, state, 0, new[] { issue });
    }
}

public sealed class WorkflowDeliveryQuery
{
    private readonly IDispatchAttemptStore history;
    private readonly ITenantAuthorizer authorizer;
    public WorkflowDeliveryQuery(IDispatchAttemptStore history, ITenantAuthorizer authorizer) { this.history = history; this.authorizer = authorizer; }

    public async Task<IReadOnlyList<DispatchAttempt>> GetAttemptsAsync(string tenantId, string actorId, string eventId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId))
        {
            return Array.Empty<DispatchAttempt>();
        }

        return await history.FindAsync(tenantId, eventId, cancellationToken).ConfigureAwait(false);
    }
}

public sealed class WorkflowBatchDispatcher
{
    private readonly WorkflowDeliveryCoordinator coordinator;
    public WorkflowBatchDispatcher(WorkflowDeliveryCoordinator coordinator) => this.coordinator = coordinator;

    public async Task<IReadOnlyList<WorkflowDeliveryResult>> DispatchAsync(string tenantId, string actorId, IReadOnlyList<AssetEvent> events, string correlationId, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(events);
        var results = new List<WorkflowDeliveryResult>(events.Count);
        foreach (var assetEvent in events)
        {
            var command = new WorkflowDeliveryCommand(tenantId, actorId, assetEvent, correlationId);
            results.Add(await coordinator.DeliverAsync(command, cancellationToken).ConfigureAwait(false));
        }

        return results;
    }
}
