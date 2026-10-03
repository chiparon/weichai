namespace AssetUpgradeGateway.Adapters;

using System.Collections.Concurrent;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Ports;

public sealed class SystemClock : IClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
}

public sealed class ManualClock : IClock
{
    private DateTimeOffset current;
    public ManualClock(DateTimeOffset initial) => current = initial;
    public DateTimeOffset UtcNow => current;
    public void Advance(TimeSpan amount) => current = current.Add(amount);
    public void Set(DateTimeOffset value) => current = value;
}

public sealed class InMemoryTenantAuthorizer : ITenantAuthorizer
{
    private readonly ConcurrentDictionary<(string Tenant, string Actor), HashSet<string>> memberships = new();
    public void Grant(string tenantId, string actorId, params string[] permissions) => memberships[(tenantId, actorId)] = new(permissions, StringComparer.OrdinalIgnoreCase);
    public bool CanAccess(string tenantId, string actorId) => memberships.ContainsKey((tenantId, actorId));
    public bool Can(string tenantId, string actorId, string permission) => memberships.TryGetValue((tenantId, actorId), out var permissions) && (permissions.Contains("*") || permissions.Contains(permission));
    public TenantScope Scope(string tenantId, string actorId, DateTimeOffset expiresAt)
    {
        memberships.TryGetValue((tenantId, actorId), out var permissions);
        var granted = permissions ?? new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        return new(tenantId, actorId, new HashSet<string>(), granted, expiresAt);
    }
}

public sealed class InMemoryIdempotencyStore : IIdempotencyStore
{
    private readonly ConcurrentDictionary<string, DateTimeOffset> completed = new(StringComparer.Ordinal);
    public bool HasCompleted(string tenantId, string operationId) => completed.ContainsKey(Key(tenantId, operationId));
    public void MarkCompleted(string tenantId, string operationId) => completed.TryAdd(Key(tenantId, operationId), DateTimeOffset.UtcNow);
    public IReadOnlyDictionary<string, DateTimeOffset> Snapshot() => new Dictionary<string, DateTimeOffset>(completed);
    private static string Key(string tenantId, string operationId) => tenantId + ":" + operationId;
}

public sealed class InMemoryAuditSink : IAuditSink, IAuditQuery
{
    private readonly ConcurrentQueue<AuditRecord> records = new();
    public void Record(AuditRecord record) => records.Enqueue(record);
    public Task<IReadOnlyList<AuditRecord>> FindAsync(string tenantId, string? subjectId, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
    {
        var result = records.Where(x => x.TenantId == tenantId && (subjectId is null || x.SubjectId == subjectId) && x.At >= from && x.At <= to).ToArray();
        return Task.FromResult<IReadOnlyList<AuditRecord>>(result);
    }
    public IReadOnlyList<AuditRecord> Snapshot() => records.ToArray();
}

public sealed class InMemoryAttachmentRepository : IAttachmentRepository
{
    private readonly ConcurrentDictionary<string, AttachmentInput> attachments = new(StringComparer.Ordinal);
    public Task<AttachmentInput?> FindAsync(string tenantId, string attachmentId, CancellationToken cancellationToken)
    {
        attachments.TryGetValue(Key(tenantId, attachmentId), out var value);
        return Task.FromResult(value);
    }
    public Task SaveAsync(AttachmentInput attachment, CancellationToken cancellationToken)
    {
        attachments[Key(attachment.TenantId, attachment.AttachmentId)] = attachment;
        return Task.CompletedTask;
    }
    public Task ReleaseAsync(string tenantId, string attachmentId, CancellationToken cancellationToken)
    {
        if (attachments.TryGetValue(Key(tenantId, attachmentId), out var value)) attachments[Key(tenantId, attachmentId)] = value with { Scanned = true };
        return Task.CompletedTask;
    }
    public IReadOnlyList<AttachmentInput> Snapshot() => attachments.Values.OrderBy(x => x.AttachmentId).ToArray();
    private static string Key(string tenantId, string id) => tenantId + ":" + id;
}

public sealed class InMemoryAttachmentScanner : IAttachmentScanner
{
    private readonly IClock clock;
    private readonly Func<AttachmentInput, bool> detector;
    public InMemoryAttachmentScanner(IClock? clock = null, Func<AttachmentInput, bool>? detector = null) { this.clock = clock ?? new SystemClock(); this.detector = detector ?? (_ => true); }
    public Task<AttachmentScanResult> ScanAsync(AttachmentInput attachment, CancellationToken cancellationToken)
    {
        var clean = detector(attachment);
        return Task.FromResult(new AttachmentScanResult(attachment.AttachmentId, clean, "deterministic-scanner", clock.UtcNow, clean ? null : "scanner-rule-match"));
    }
}

public sealed class InMemoryAttachmentQuarantine : IAttachmentQuarantine
{
    private readonly ConcurrentDictionary<string, string> rejected = new(StringComparer.Ordinal);
    public bool IsSafe(AttachmentInput attachment) => attachment.Scanned && !rejected.ContainsKey(attachment.AttachmentId);
    public void Reject(string attachmentId, string reason) => rejected[attachmentId] = reason;
    public bool TryGetReason(string attachmentId, out string? reason) => rejected.TryGetValue(attachmentId, out reason);
}

public sealed class InMemoryDeadLetterSink : IDeadLetterSink
{
    private readonly ConcurrentQueue<DeadLetterEvent> events = new();
    public Task PublishAsync(DeadLetterEvent deadLetter, CancellationToken cancellationToken) { events.Enqueue(deadLetter); return Task.CompletedTask; }
    public Task<IReadOnlyList<DeadLetterEvent>> FindByTenantAsync(string tenantId, CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<DeadLetterEvent>>(events.Where(x => x.Event.TenantId == tenantId).ToArray());
    public IReadOnlyList<DeadLetterEvent> Snapshot() => events.ToArray();
}

public sealed class InMemoryMetricsSink : IMetricsSink
{
    private readonly ConcurrentDictionary<(string Tenant, string Name), long> counters = new();
    private readonly ConcurrentDictionary<(string Tenant, string Name), TimeSpan> timings = new();
    public void Increment(string name, string tenantId) => counters.AddOrUpdate((tenantId, name), 1, (_, value) => value + 1);
    public void Timing(string name, string tenantId, TimeSpan duration) => timings[(tenantId, name)] = duration;
    public MetricSnapshot Snapshot(string tenantId) => new(tenantId, counters.Where(x => x.Key.Tenant == tenantId).ToDictionary(x => x.Key.Name, x => x.Value), timings.Where(x => x.Key.Tenant == tenantId).ToDictionary(x => x.Key.Name, x => x.Value));
}

public sealed class InMemoryRetryableEventStore : IRetryableEventStore, IEventEnvelopeStore
{
    private readonly ConcurrentDictionary<string, PendingEvent> pending = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, EventEnvelope> envelopes = new(StringComparer.Ordinal);
    public Task<IReadOnlyList<PendingEvent>> FindDueAsync(DateTimeOffset now, int limit, CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<PendingEvent>>(pending.Values.Where(x => x.Retryable && x.RetryAfter <= now).OrderBy(x => x.RetryAfter).Take(limit).ToArray());
    public Task MarkRetryableAsync(PendingEvent pendingEvent, DateTimeOffset retryAfter, CancellationToken cancellationToken) { pending[pendingEvent.Event.EventId] = pendingEvent with { RetryAfter = retryAfter, Attempts = pendingEvent.Attempts + 1 }; return Task.CompletedTask; }
    public Task<EventEnvelope?> FindAsync(string tenantId, string eventId, CancellationToken cancellationToken) { envelopes.TryGetValue(Key(tenantId, eventId), out var value); return Task.FromResult(value); }
    public Task SaveAsync(EventEnvelope envelope, CancellationToken cancellationToken) { envelopes[Key(envelope.Event.TenantId, envelope.Event.EventId)] = envelope; return Task.CompletedTask; }
    public Task<IReadOnlyList<EventEnvelope>> FindByStageAsync(string tenantId, EventProcessingStage stage, int limit, CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<EventEnvelope>>(envelopes.Values.Where(x => x.Event.TenantId == tenantId && x.Stage == stage).Take(limit).ToArray());
    public void Add(PendingEvent item) => pending[item.Event.EventId] = item;
    private static string Key(string tenantId, string eventId) => tenantId + ":" + eventId;
}

public sealed class InMemoryWorkflowDispatcher : IWorkflowDispatcher
{
    private readonly ConcurrentQueue<AssetEvent> dispatched = new();
    private readonly Func<AssetEvent, DeliveryStatus> behavior;
    public InMemoryWorkflowDispatcher(Func<AssetEvent, DeliveryStatus>? behavior = null) => this.behavior = behavior ?? (_ => DeliveryStatus.Accepted);
    public Task<DeliveryResult> DispatchAsync(AssetEvent assetEvent, CancellationToken cancellationToken)
    {
        var status = behavior(assetEvent);
        if (status == DeliveryStatus.Accepted) dispatched.Enqueue(assetEvent);
        return Task.FromResult(new DeliveryResult(status == DeliveryStatus.Accepted, status));
    }
    public IReadOnlyList<AssetEvent> Snapshot() => dispatched.ToArray();
}

public sealed class InMemoryDispatchHistory : IDispatchHistory, IDispatchAttemptStore
{
    private readonly ConcurrentQueue<DispatchAttempt> attempts = new();
    public Task AppendAsync(DispatchAttempt attempt, CancellationToken cancellationToken) { attempts.Enqueue(attempt); return Task.CompletedTask; }
    public Task<IReadOnlyList<DispatchAttempt>> FindAsync(string tenantId, string eventId, CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<DispatchAttempt>>(attempts.Where(x => x.TenantId == tenantId && x.EventId == eventId).OrderBy(x => x.Attempt).ToArray());
    public IReadOnlyList<DispatchAttempt> Snapshot() => attempts.ToArray();
}

public sealed class InMemoryOrderRepository : IOrderAggregateRepository
{
    private readonly ConcurrentDictionary<string, OrderSnapshot> snapshots = new(StringComparer.Ordinal);
    public Task<bool> ExistsAsync(string tenantId, string orderId, CancellationToken cancellationToken) => Task.FromResult(snapshots.ContainsKey(Key(tenantId, orderId)));
    public Task<OrderSnapshot?> FindAsync(string tenantId, string orderId, CancellationToken cancellationToken) { snapshots.TryGetValue(Key(tenantId, orderId), out var value); return Task.FromResult(value); }
    public Task SaveAsync(OrderSnapshot snapshot, CancellationToken cancellationToken) { snapshots[Key(snapshot.Request.TenantId, snapshot.Request.OrderId)] = snapshot; return Task.CompletedTask; }
    public IReadOnlyList<OrderSnapshot> Snapshot() => snapshots.Values.ToArray();
    private static string Key(string tenantId, string orderId) => tenantId + ":" + orderId;
}


public sealed class InMemoryOrderRequestRepository : IOrderRepository
{
    private readonly ConcurrentDictionary<string, OrderRequest> requests = new(StringComparer.Ordinal);
    public Task<OrderRequest?> FindAsync(string tenantId, string orderId, CancellationToken cancellationToken) { requests.TryGetValue(Key(tenantId, orderId), out var value); return Task.FromResult(value); }
    public Task SaveAsync(OrderRequest order, CancellationToken cancellationToken) { requests[Key(order.TenantId, order.OrderId)] = order; return Task.CompletedTask; }
    public Task<bool> ExistsAsync(string tenantId, string orderId, CancellationToken cancellationToken) => Task.FromResult(requests.ContainsKey(Key(tenantId, orderId)));
    private static string Key(string tenantId, string orderId) => tenantId + ":" + orderId;
}

public sealed class InMemoryInventoryGateway : IInventoryGateway, IReservationLedger
{
    private readonly ConcurrentDictionary<string, InventoryReservation> reservations = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, int> stock = new(StringComparer.OrdinalIgnoreCase);
    private readonly IClock clock;
    public InMemoryInventoryGateway(IClock? clock = null) => this.clock = clock ?? new SystemClock();
    public void Seed(string sku, int quantity) => stock[sku] = quantity;
    public Task<ReservationResult> ReserveAsync(OrderRequest order, CancellationToken cancellationToken)
    {
        foreach (var line in order.Lines)
            if (!stock.TryGetValue(line.Sku, out var available) || available < line.Quantity) return Task.FromResult(new ReservationResult(false, null, $"Insufficient stock for {line.Sku}."));
        foreach (var line in order.Lines) stock[line.Sku] -= line.Quantity;
        var id = $"res-{order.OrderId}-{Guid.NewGuid():N}";
        var reservation = new InventoryReservation(id, order.TenantId, order.OrderId, order.Lines.ToDictionary(x => x.Sku, x => x.Quantity, StringComparer.OrdinalIgnoreCase), clock.UtcNow.AddMinutes(15), false);
        reservations[id] = reservation;
        return Task.FromResult(new ReservationResult(true, id));
    }
    public Task<InventoryReservation?> FindAsync(string tenantId, string reservationId, CancellationToken cancellationToken) { reservations.TryGetValue(reservationId, out var value); return Task.FromResult(value?.TenantId == tenantId ? value : null); }
    public Task SaveAsync(InventoryReservation reservation, CancellationToken cancellationToken) { reservations[reservation.ReservationId] = reservation; return Task.CompletedTask; }
    public Task ReleaseAsync(string tenantId, string reservationId, CancellationToken cancellationToken) { if (reservations.TryGetValue(reservationId, out var value) && value.TenantId == tenantId) reservations[reservationId] = value.Release(); return Task.CompletedTask; }
}

public sealed class InMemoryOrderCommitter : IOrderCommitter
{
    private readonly ConcurrentQueue<OrderCommitReceipt> receipts = new();
    private readonly IClock clock;
    public InMemoryOrderCommitter(IClock? clock = null) => this.clock = clock ?? new SystemClock();
    public Task CommitAsync(OrderRequest order, ReservationResult reservation, CancellationToken cancellationToken)
    {
        if (!reservation.Reserved || reservation.ReservationId is null) throw new InvalidOperationException("A successful reservation is required.");
        receipts.Enqueue(new(order.OrderId, reservation.ReservationId, $"commit-{Guid.NewGuid():N}", clock.UtcNow));
        return Task.CompletedTask;
    }
    public IReadOnlyList<OrderCommitReceipt> Snapshot() => receipts.ToArray();
}

public sealed class InMemoryPluginRegistry : IPluginRegistry
{
    private readonly ConcurrentDictionary<string, PluginDescriptor> plugins = new(StringComparer.Ordinal);
    public Task RegisterAsync(PluginDescriptor descriptor, CancellationToken cancellationToken) { plugins[Key(descriptor.TenantId, descriptor.PluginId)] = descriptor; return Task.CompletedTask; }
    public Task<PluginDescriptor?> FindCapabilityAsync(string tenantId, string capability, CancellationToken cancellationToken) => Task.FromResult(plugins.Values.FirstOrDefault(x => x.TenantId == tenantId && x.Supports(capability)));
    public Task<IReadOnlyList<PluginDescriptor>> ListAsync(string tenantId, CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<PluginDescriptor>>(plugins.Values.Where(x => x.TenantId == tenantId).OrderBy(x => x.PluginId).ToArray());
    private static string Key(string tenantId, string pluginId) => tenantId + ":" + pluginId;
}

public sealed class InMemoryTransactionBoundary : ITransactionBoundary
{
    private readonly SemaphoreSlim gate = new(1, 1);
    public async Task<T> ExecuteAsync<T>(Func<CancellationToken, Task<T>> operation, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try { return await operation(cancellationToken); }
        finally { gate.Release(); }
    }
}

public sealed class InMemoryLeaseStore : ILeaseStore
{
    private readonly ConcurrentDictionary<string, LeaseClaim> claims = new(StringComparer.Ordinal);
    public Task<bool> TryClaimAsync(string tenantId, string key, TimeSpan duration, CancellationToken cancellationToken)
    {
        var composite = tenantId + ":" + key;
        var now = DateTimeOffset.UtcNow;
        var claim = new LeaseClaim(tenantId, key, now.Add(duration), Environment.MachineName);
        var accepted = claims.AddOrUpdate(composite, claim, (_, old) => old.ExpiresAt <= now ? claim : old) == claim;
        return Task.FromResult(accepted);
    }
    public Task ReleaseAsync(string tenantId, string key, CancellationToken cancellationToken) { claims.TryRemove(tenantId + ":" + key, out _); return Task.CompletedTask; }
}

public sealed class InMemoryCheckpointStore : ICheckpointStore
{
    private readonly ConcurrentDictionary<string, string> values = new(StringComparer.Ordinal);
    public Task<string?> GetAsync(string tenantId, string jobName, CancellationToken cancellationToken) { values.TryGetValue(Key(tenantId, jobName), out var value); return Task.FromResult(value); }
    public Task PutAsync(string tenantId, string jobName, string checkpoint, CancellationToken cancellationToken) { values[Key(tenantId, jobName)] = checkpoint; return Task.CompletedTask; }
    private static string Key(string tenantId, string jobName) => tenantId + ":" + jobName;
}

public sealed class InMemoryQuarantineLog : IQuarantineLog
{
    private readonly ConcurrentQueue<QuarantineEntry> entries = new();
    public Task RecordAsync(string tenantId, string attachmentId, IReadOnlyList<ValidationIssue> issues, CancellationToken cancellationToken) { entries.Enqueue(new(tenantId, attachmentId, issues, DateTimeOffset.UtcNow)); return Task.CompletedTask; }
    public Task<IReadOnlyList<string>> FindAsync(string tenantId, CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<string>>(entries.Where(x => x.TenantId == tenantId).Select(x => x.AttachmentId).ToArray());
}

public sealed class InMemoryFeatureFlags : IFeatureFlags
{
    private readonly ConcurrentDictionary<(string Tenant, string Flag), bool> flags = new();
    public void Set(string tenantId, string flag, bool enabled) => flags[(tenantId, flag)] = enabled;
    public bool Enabled(string tenantId, string flag) => flags.TryGetValue((tenantId, flag), out var enabled) && enabled;
}
