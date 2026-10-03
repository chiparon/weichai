namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;

public sealed record ReconciliationCommand(string TenantId, string ActorId, DateTimeOffset Now, int Limit, string JobName);
public sealed record ReconciliationOutcome(ReconciliationReport Report, string? Checkpoint, IReadOnlyList<ValidationIssue> Issues);

public sealed class ReconciliationOrchestrator
{
    private readonly ITenantAuthorizer authorizer;
    private readonly IRetryableEventStore store;
    private readonly IWorkflowDispatcher dispatcher;
    private readonly IIdempotencyStore idempotency;
    private readonly IAuditSink audit;
    private readonly ICheckpointStore checkpoints;
    private readonly ILeaseStore leases;
    private readonly IRetryPolicy retry;
    private readonly IMetricsSink metrics;

    public ReconciliationOrchestrator(ITenantAuthorizer authorizer, IRetryableEventStore store, IWorkflowDispatcher dispatcher, IIdempotencyStore idempotency, IAuditSink audit, ICheckpointStore checkpoints, ILeaseStore leases, IMetricsSink metrics, IRetryPolicy? retry = null)
    {
        this.authorizer = authorizer; this.store = store; this.dispatcher = dispatcher; this.idempotency = idempotency; this.audit = audit; this.checkpoints = checkpoints; this.leases = leases; this.metrics = metrics; this.retry = retry ?? new ExponentialRetryPolicy();
    }

    public async Task<ReconciliationOutcome> RunAsync(ReconciliationCommand command, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(command.TenantId, command.ActorId))
            return new(new(0, 0, 0, 0, []), null, [new("tenant.access.denied", "Actor cannot reconcile tenant.", ValidationSeverity.Error)]);
        if (command.Limit <= 0) return new(new(0, 0, 0, 0, []), null, [new("batch.limit.invalid", "Reconciliation limit must be positive.", ValidationSeverity.Error)]);
        if (!await leases.TryClaimAsync(command.TenantId, command.JobName, TimeSpan.FromMinutes(5), cancellationToken))
            return new(new(0, 0, 0, 0, []), null, [new("reconciliation.lease.busy", "Another reconciliation run owns the lease.", ValidationSeverity.Warning)]);
        try
        {
            var cursor = await checkpoints.GetAsync(command.TenantId, command.JobName, cancellationToken);
            var due = await store.FindDueAsync(command.Now, command.Limit, cancellationToken);
            var examined = due.Count; var retried = 0; var succeeded = 0; var failed = 0; var ids = new List<string>();
            foreach (var pending in due.OrderBy(x => x.RetryAfter))
            {
                cancellationToken.ThrowIfCancellationRequested();
                ids.Add(pending.Event.EventId);
                if (idempotency.HasCompleted(command.TenantId, pending.Event.EventId)) { succeeded++; continue; }
                var result = await dispatcher.DispatchAsync(pending.Event, cancellationToken);
                if (result.Accepted)
                {
                    idempotency.MarkCompleted(command.TenantId, pending.Event.EventId); succeeded++; metrics.Increment("reconciliation.succeeded", command.TenantId);
                    audit.Record(new(command.TenantId, pending.Event.EventId, "reconciliation.dispatch", "accepted", command.Now));
                }
                else if (retry.CanRetry(pending.Attempts))
                {
                    await store.MarkRetryableAsync(pending, retry.NextAttempt(command.Now, pending.Attempts), cancellationToken); retried++; metrics.Increment("reconciliation.retried", command.TenantId);
                }
                else { failed++; metrics.Increment("reconciliation.failed", command.TenantId); audit.Record(new(command.TenantId, pending.Event.EventId, "reconciliation.dispatch", "failed", command.Now)); }
                cursor = pending.Event.EventId;
            }
            await checkpoints.PutAsync(command.TenantId, command.JobName, cursor ?? string.Empty, cancellationToken);
            var report = new ReconciliationReport(examined, retried, succeeded, failed, ids);
            return new(report, cursor, []);
        }
        finally { await leases.ReleaseAsync(command.TenantId, command.JobName, cancellationToken); }
    }
}

public sealed class ReconciliationReportFormatter
{
    public string ToText(ReconciliationOutcome outcome)
    {
        var report = outcome.Report;
        return string.Join(Environment.NewLine, $"examined={report.Examined}", $"retried={report.Retried}", $"succeeded={report.Succeeded}", $"failed={report.Failed}", $"checkpoint={outcome.Checkpoint ?? "none"}");
    }
}

public sealed class DueWindowCalculator
{
    public BatchWindow Compute(DateTimeOffset now, TimeSpan lookback, TimeSpan lookahead, int limit)
    {
        if (lookback < TimeSpan.Zero || lookahead < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(lookback));
        return new(now.Subtract(lookback), now.Add(lookahead), Math.Max(1, limit));
    }
    public bool Contains(BatchWindow window, DateTimeOffset value) => value >= window.From && value <= window.To;
}
