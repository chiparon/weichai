namespace AssetUpgradeGateway.Application;

using System.Diagnostics;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;

public sealed record ReconciliationCommand(string TenantId, string ActorId, DateTimeOffset Now, int Limit, string JobName);
public sealed record ReconciliationOutcome(ReconciliationReport Report, string? Checkpoint, IReadOnlyList<ValidationIssue> Issues);

public sealed class ReconciliationOrchestrator
{
    private static readonly TimeSpan LeaseDuration = TimeSpan.FromMinutes(5);

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
        ArgumentNullException.ThrowIfNull(command);
        cancellationToken.ThrowIfCancellationRequested();

        if (!authorizer.CanAccess(command.TenantId, command.ActorId))
        {
            var forbidden = new ValidationIssue("reconciliation.forbidden", "Actor is not authorized for the tenant.", ValidationSeverity.Error);
            return new ReconciliationOutcome(EmptyReport(), null, new[] { forbidden });
        }

        var leaseKey = "reconciliation:" + command.JobName;
        var claimed = await leases.TryClaimAsync(command.TenantId, leaseKey, LeaseDuration, cancellationToken).ConfigureAwait(false);
        if (!claimed)
        {
            var busy = new ValidationIssue("reconciliation.lease", "A reconciliation run is already in progress for the tenant.", ValidationSeverity.Warning);
            return new ReconciliationOutcome(EmptyReport(), null, new[] { busy });
        }

        try
        {
            var checkpoint = await checkpoints.GetAsync(command.TenantId, command.JobName, cancellationToken).ConfigureAwait(false);
            var limit = command.Limit <= 0 ? int.MaxValue : command.Limit;
            var stopwatch = Stopwatch.StartNew();
            var due = await store.FindDueAsync(command.Now, limit, cancellationToken).ConfigureAwait(false);
            var budget = new RetryBudgetPolicy(retry);

            var examined = 0;
            var retried = 0;
            var succeeded = 0;
            var failed = 0;
            var eventIds = new List<string>();
            var lastEventId = checkpoint;

            foreach (var pending in due)
            {
                cancellationToken.ThrowIfCancellationRequested();
                examined++;

                var assetEvent = pending.Event;
                lastEventId = assetEvent.EventId;
                eventIds.Add(assetEvent.EventId);

                if (idempotency.HasCompleted(assetEvent.TenantId, assetEvent.EventId))
                {
                    continue;
                }

                var outcome = await dispatcher.DispatchAsync(assetEvent, cancellationToken).ConfigureAwait(false);
                if (outcome.Status == DeliveryStatus.Accepted)
                {
                    idempotency.MarkCompleted(assetEvent.TenantId, assetEvent.EventId);
                    succeeded++;
                }
                else if (outcome.Status == DeliveryStatus.Retryable)
                {
                    var attempts = pending.Attempts + 1;
                    var decision = budget.Evaluate(attempts, command.Now);
                    if (decision.Allowed)
                    {
                        var next = retry.NextAttempt(command.Now, attempts);
                        await store.MarkRetryableAsync(pending, next, cancellationToken).ConfigureAwait(false);
                        retried++;
                    }
                    else
                    {
                        failed++;
                    }
                }
                else
                {
                    failed++;
                }
            }

            stopwatch.Stop();
            var checkpointValue = $"{lastEventId ?? string.Empty}|{command.Now:O}|{examined}";
            await checkpoints.PutAsync(command.TenantId, command.JobName, checkpointValue, cancellationToken).ConfigureAwait(false);

            metrics.Increment("reconciliation.examined", command.TenantId);
            metrics.Increment("reconciliation.succeeded", command.TenantId);
            metrics.Timing("reconciliation.run", command.TenantId, stopwatch.Elapsed);

            var report = new ReconciliationReport(examined, retried, succeeded, failed, eventIds);
            audit.Record(new AuditRecord(
                command.TenantId,
                command.JobName,
                "reconciliation.run",
                $"examined={examined};retried={retried};succeeded={succeeded};failed={failed};events={string.Join(",", eventIds)}",
                DateTimeOffset.UtcNow));

            return new ReconciliationOutcome(report, checkpointValue, Array.Empty<ValidationIssue>());
        }
        finally
        {
            await leases.ReleaseAsync(command.TenantId, leaseKey, cancellationToken).ConfigureAwait(false);
        }
    }

    private static ReconciliationReport EmptyReport() => new(0, 0, 0, 0, Array.Empty<string>());
}

public sealed class ReconciliationReportFormatter
{
    public string ToText(ReconciliationOutcome outcome)
    {
        ArgumentNullException.ThrowIfNull(outcome);
        var report = outcome.Report;
        return $"reconciliation examined={report.Examined} retried={report.Retried} succeeded={report.Succeeded} failed={report.Failed} events=[{string.Join(",", report.EventIds)}]";
    }
}

public sealed class DueWindowCalculator
{
    public BatchWindow Compute(DateTimeOffset now, TimeSpan lookback, TimeSpan lookahead, int limit)
        => new(now - lookback, now + lookahead, limit);

    public bool Contains(BatchWindow window, DateTimeOffset value)
        => value >= window.From && value <= window.To;
}
