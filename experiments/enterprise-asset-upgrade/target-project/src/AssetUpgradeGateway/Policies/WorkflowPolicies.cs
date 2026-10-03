namespace AssetUpgradeGateway.Policies;

using AssetUpgradeGateway;

public sealed class WorkflowStateTransitionPolicy : IWorkflowStateMachine
{
    private static readonly IReadOnlyDictionary<WorkflowState, IReadOnlySet<WorkflowState>> Allowed = new Dictionary<WorkflowState, IReadOnlySet<WorkflowState>>
    {
        [WorkflowState.New] = new HashSet<WorkflowState> { WorkflowState.Approved, WorkflowState.Failed },
        [WorkflowState.Approved] = new HashSet<WorkflowState> { WorkflowState.Dispatched, WorkflowState.Failed },
        [WorkflowState.Dispatched] = new HashSet<WorkflowState> { WorkflowState.Completed, WorkflowState.RetryPending, WorkflowState.Failed },
        [WorkflowState.RetryPending] = new HashSet<WorkflowState> { WorkflowState.Dispatched, WorkflowState.Failed },
        [WorkflowState.Completed] = new HashSet<WorkflowState>(),
        [WorkflowState.Failed] = new HashSet<WorkflowState>(),
    };

    public bool CanTransition(WorkflowState from, WorkflowState to) => Allowed.TryGetValue(from, out var next) && next.Contains(to);

    public WorkflowState Transition(WorkflowState from, WorkflowState to)
        => CanTransition(from, to) ? to : throw new InvalidOperationException($"Workflow transition {from} -> {to} is not allowed.");

    public IReadOnlyList<WorkflowState> ReachableFrom(WorkflowState from) => Allowed.TryGetValue(from, out var next) ? [.. next] : [];
}

public sealed record RetryPolicyOptions(int MaximumAttempts, TimeSpan InitialDelay, TimeSpan MaximumDelay, double Multiplier, bool AddJitter);

public sealed class ExponentialRetryPolicy : IRetryPolicy
{
    private readonly RetryPolicyOptions options;
    public ExponentialRetryPolicy(RetryPolicyOptions? options = null) => this.options = options ?? new(5, TimeSpan.FromSeconds(2), TimeSpan.FromMinutes(20), 2, false);
    public bool CanRetry(int attempts) => attempts < options.MaximumAttempts;
    public DateTimeOffset NextAttempt(DateTimeOffset now, int attempts)
    {
        if (!CanRetry(attempts)) throw new InvalidOperationException("Retry budget exhausted.");
        var multiplier = Math.Pow(options.Multiplier, Math.Max(0, attempts));
        var ticks = Math.Min(options.MaximumDelay.Ticks, (long)(options.InitialDelay.Ticks * multiplier));
        var jitter = options.AddJitter ? Random.Shared.NextInt64(0, Math.Max(1, ticks / 5)) : 0;
        return now.AddTicks(Math.Min(options.MaximumDelay.Ticks, ticks + jitter));
    }
}

public sealed class EventEnvelopePolicy
{
    private readonly IWorkflowStateMachine machine;
    public EventEnvelopePolicy(IWorkflowStateMachine? machine = null) => this.machine = machine ?? new WorkflowStateTransitionPolicy();

    public PolicyResult Validate(AssetEvent assetEvent, EventEnvelope envelope)
    {
        var issues = new List<ValidationIssue>();
        if (envelope.Event.EventId != assetEvent.EventId) issues.Add(new("event.identity", "Envelope event identity does not match payload.", ValidationSeverity.Error));
        if (envelope.DeliveryAttempt < 0) issues.Add(new("event.attempt.negative", "Delivery attempt cannot be negative.", ValidationSeverity.Error));
        if (envelope.EnqueuedAt < assetEvent.CreatedAt) issues.Add(new("event.clock.order", "An event cannot be queued before it was created.", ValidationSeverity.Error));
        if (!machine.ReachableFrom(WorkflowState.New).Contains(WorkflowState.Approved) && envelope.Stage == EventProcessingStage.Authorized)
            issues.Add(new("event.machine.unavailable", "Workflow state machine does not authorize events.", ValidationSeverity.Error));
        return issues.Count == 0 ? PolicyResult.Allow() : PolicyResult.Deny([.. issues]);
    }
}

public sealed class DuplicateDeliveryPolicy
{
    public PolicyResult Evaluate(IReadOnlyList<DispatchAttempt> attempts, AssetEvent assetEvent)
    {
        if (attempts.Count == 0) return PolicyResult.Allow();
        var terminal = attempts.Any(a => a.Status == DeliveryStatus.Accepted);
        if (terminal) return PolicyResult.Deny(new("event.duplicate.completed", "The event was already delivered successfully.", ValidationSeverity.Warning));
        if (attempts.GroupBy(a => a.Attempt).Any(g => g.Count() > 1))
            return PolicyResult.Deny(new("event.duplicate.attempt", "The same delivery attempt was recorded more than once.", ValidationSeverity.Error));
        return PolicyResult.Allow();
    }
}

public sealed class RetryBudgetPolicy
{
    private readonly IRetryPolicy retry;
    public RetryBudgetPolicy(IRetryPolicy? retry = null) => this.retry = retry ?? new ExponentialRetryPolicy();
    public PolicyResult Evaluate(int attempts, DateTimeOffset now)
        => retry.CanRetry(attempts)
            ? PolicyResult.Allow()
            : PolicyResult.Deny(new("event.retry.exhausted", $"Retry budget exhausted after {attempts} attempts.", ValidationSeverity.Error));
    public DateTimeOffset Schedule(DateTimeOffset now, int attempts) => retry.NextAttempt(now, attempts);
}

public sealed class TenantBatchPolicy
{
    public PolicyResult Evaluate(string tenantId, IReadOnlyList<PendingEvent> events, int limit)
    {
        var issues = new List<ValidationIssue>();
        if (string.IsNullOrWhiteSpace(tenantId)) issues.Add(new("batch.tenant.empty", "Tenant is required.", ValidationSeverity.Error));
        if (events.Count > limit) issues.Add(new("batch.limit", "Batch exceeds its requested limit.", ValidationSeverity.Error));
        if (events.Any(e => !string.Equals(e.Event.TenantId, tenantId, StringComparison.Ordinal))) issues.Add(new("batch.tenant.mixed", "A batch cannot contain multiple tenants.", ValidationSeverity.Error));
        return issues.Count == 0 ? PolicyResult.Allow() : PolicyResult.Deny([.. issues]);
    }
}

public sealed class CorrelationPolicy
{
    public PolicyResult Evaluate(EventEnvelope envelope)
    {
        var issues = new List<ValidationIssue>();
        if (string.IsNullOrWhiteSpace(envelope.CorrelationId)) issues.Add(new("event.correlation.empty", "Correlation id is required.", ValidationSeverity.Error));
        if (string.IsNullOrWhiteSpace(envelope.CausationId)) issues.Add(new("event.causation.empty", "Causation id is required.", ValidationSeverity.Error));
        if (envelope.CorrelationId.Length > 128 || envelope.CausationId.Length > 128) issues.Add(new("event.correlation.length", "Correlation identifiers are too long.", ValidationSeverity.Error));
        return issues.Count == 0 ? PolicyResult.Allow() : PolicyResult.Deny([.. issues]);
    }
}
