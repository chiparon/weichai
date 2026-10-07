namespace AssetUpgradeGateway;

public sealed class ReconciliationService
{
    private const string RunAction = "reconciliation.run";
    private const string ForbiddenAction = "reconciliation.forbidden";
    private const int MaxBackoffSeconds = 60;
    private const int MaxBackoffShift = 6;

    private readonly ITenantAuthorizer authorizer;
    private readonly IRetryableEventStore eventStore;
    private readonly IWorkflowDispatcher dispatcher;
    private readonly IIdempotencyStore idempotency;
    private readonly IAuditSink audit;

    public ReconciliationService(
        ITenantAuthorizer authorizer,
        IRetryableEventStore eventStore,
        IWorkflowDispatcher dispatcher,
        IIdempotencyStore idempotency,
        IAuditSink audit)
    {
        this.authorizer = authorizer;
        this.eventStore = eventStore;
        this.dispatcher = dispatcher;
        this.idempotency = idempotency;
        this.audit = audit;
    }

    /// <summary>
    /// Scheduled reconciliation entry point. Mirrors the historical worker
    /// <c>RunAsync</c> launcher while carrying the per-run unit of work directly
    /// on the entry point: it re-drives due retryable events tenant-by-tenant,
    /// marks a delivery complete exactly once, reschedules retryable events with
    /// clamped exponential backoff and always writes a traceable run summary.
    /// Every invocation is independently re-runnable.
    /// </summary>
    public async Task<ReconciliationReport> RunAsync(
        string actorId,
        DateTimeOffset now,
        int limit,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var effectiveLimit = limit <= 0 ? int.MaxValue : limit;
        var due = await eventStore
            .FindDueAsync(now, effectiveLimit, cancellationToken)
            .ConfigureAwait(false);

        var examined = 0;
        var retried = 0;
        var succeeded = 0;
        var failed = 0;
        var eventIds = new List<string>();

        foreach (var pending in due)
        {
            cancellationToken.ThrowIfCancellationRequested();

            examined++;
            eventIds.Add(pending.Event.EventId);

            if (!authorizer.CanAccess(pending.Event.TenantId, actorId))
            {
                audit.Record(new AuditRecord(
                    pending.Event.TenantId,
                    pending.Event.EventId,
                    ForbiddenAction,
                    "forbidden",
                    now));
                continue;
            }

            if (!pending.Retryable)
            {
                continue;
            }

            if (idempotency.HasCompleted(pending.Event.TenantId, pending.Event.EventId))
            {
                continue;
            }

            DeliveryResult outcome;
            try
            {
                outcome = await dispatcher
                    .DispatchAsync(pending.Event, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception)
            {
                outcome = new DeliveryResult(false, DeliveryStatus.Retryable);
            }

            if (outcome.Status == DeliveryStatus.Accepted)
            {
                idempotency.MarkCompleted(pending.Event.TenantId, pending.Event.EventId);
                succeeded++;
            }
            else if (outcome.Status == DeliveryStatus.Retryable)
            {
                var attempts = pending.Attempts + 1;
                var backoffSeconds = Math.Min(MaxBackoffSeconds, 1 << Math.Min(attempts, MaxBackoffShift));
                var retryAfter = now + TimeSpan.FromSeconds(backoffSeconds);
                await eventStore
                    .MarkRetryableAsync(pending, retryAfter, cancellationToken)
                    .ConfigureAwait(false);
                retried++;
            }
            else
            {
                failed++;
            }
        }

        var summary =
            $"examined={examined};retried={retried};succeeded={succeeded};failed={failed};events={string.Join(",", eventIds)}";
        audit.Record(new AuditRecord("*", actorId, RunAction, summary, now));

        return new ReconciliationReport(examined, retried, succeeded, failed, eventIds);
    }
}
