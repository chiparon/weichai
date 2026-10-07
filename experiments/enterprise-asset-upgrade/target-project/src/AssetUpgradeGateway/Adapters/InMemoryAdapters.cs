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
    public void Grant(string tenantId, string actorId, params string[] permissions)
    {
        var grants = memberships.GetOrAdd((tenantId, actorId), _ => new HashSet<string>(StringComparer.OrdinalIgnoreCase));
        lock (grants)
        {
            foreach (var permission in permissions)
            {
                if (!string.IsNullOrWhiteSpace(permission))
                {
                    grants.Add(permission);
                }
            }
        }
    }
    public bool CanAccess(string tenantId, string actorId) => memberships.ContainsKey((tenantId, actorId));
    public bool Can(string tenantId, string actorId, string permission)
    {
        if (!memberships.TryGetValue((tenantId, actorId), out var grants))
        {
            return false;
        }

        lock (grants)
        {
            return grants.Contains(permission);
        }
    }
    public TenantScope Scope(string tenantId, string actorId, DateTimeOffset expiresAt)
    {
        var permissions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (memberships.TryGetValue((tenantId, actorId), out var grants))
        {
            lock (grants)
            {
                permissions.UnionWith(grants);
            }
        }

        return new TenantScope(
            tenantId,
            actorId,
            new HashSet<string>(StringComparer.OrdinalIgnoreCase),
            permissions,
            expiresAt);
    }
}

public sealed class InMemoryIdempotencyStore : IIdempotencyStore
{
    private readonly ConcurrentDictionary<string, DateTimeOffset> completed = new(StringComparer.Ordinal);
    public bool HasCompleted(string tenantId, string operationId) => completed.ContainsKey(Key(tenantId, operationId));
    public void MarkCompleted(string tenantId, string operationId) => completed[Key(tenantId, operationId)] = DateTimeOffset.UtcNow;
    public IReadOnlyDictionary<string, DateTimeOffset> Snapshot() => new Dictionary<string, DateTimeOffset>(completed, StringComparer.Ordinal);
    private static string Key(string tenantId, string operationId) => tenantId + ":" + operationId;
}

public sealed class InMemoryAuditSink : IAuditSink, IAuditQuery
{
    private readonly ConcurrentQueue<AuditRecord> records = new();
    public void Record(AuditRecord record) => records.Enqueue(record);
    public Task<IReadOnlyList<AuditRecord>> FindAsync(string tenantId, string? subjectId, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        IReadOnlyList<AuditRecord> matches = records
            .Where(record => string.Equals(record.TenantId, tenantId, StringComparison.Ordinal))
            .Where(record => subjectId is null || string.Equals(record.SubjectId, subjectId, StringComparison.Ordinal))
            .Where(record => record.At >= from && record.At <= to)
            .OrderBy(record => record.At)
            .ToList();
        return Task.FromResult(matches);
    }
    public IReadOnlyList<AuditRecord> Snapshot() => records.ToList();
}

public sealed class InMemoryAttachmentRepository : IAttachmentRepository
{
    private readonly ConcurrentDictionary<string, AttachmentInput> attachments = new(StringComparer.Ordinal);
    public Task<AttachmentInput?> FindAsync(string tenantId, string attachmentId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        attachments.TryGetValue(Key(tenantId, attachmentId), out var attachment);
        return Task.FromResult<AttachmentInput?>(attachment);
    }
    public Task SaveAsync(AttachmentInput attachment, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        attachments[Key(attachment.TenantId, attachment.AttachmentId)] = attachment;
        return Task.CompletedTask;
    }
    public Task ReleaseAsync(string tenantId, string attachmentId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        attachments.TryRemove(Key(tenantId, attachmentId), out _);
        return Task.CompletedTask;
    }
    public IReadOnlyList<AttachmentInput> Snapshot() => attachments.Values.ToList();
    private static string Key(string tenantId, string id) => tenantId + ":" + id;
}

public sealed class InMemoryAttachmentScanner : IAttachmentScanner
{
    private readonly IClock clock;
    private readonly Func<AttachmentInput, bool>? detector;
    public InMemoryAttachmentScanner(IClock? clock = null, Func<AttachmentInput, bool>? detector = null) { this.clock = clock ?? new SystemClock(); this.detector = detector; }
    public Task<AttachmentScanResult> ScanAsync(AttachmentInput attachment, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var flagged = detector is not null && detector(attachment);
        var result = new AttachmentScanResult(
            attachment.AttachmentId,
            Clean: !flagged,
            Scanner: "in-memory",
            ScannedAt: clock.UtcNow,
            Detail: flagged ? "flagged by detector" : null);
        return Task.FromResult(result);
    }
}

public sealed class InMemoryAttachmentQuarantine : IAttachmentQuarantine
{
    private readonly ConcurrentDictionary<string, string> rejected = new(StringComparer.Ordinal);
    public bool IsSafe(AttachmentInput attachment) => !rejected.ContainsKey(attachment.AttachmentId);
    public void Reject(string attachmentId, string reason) => rejected[attachmentId] = reason;
    public bool TryGetReason(string attachmentId, out string? reason) => rejected.TryGetValue(attachmentId, out reason);
}

public sealed class InMemoryDeadLetterSink : IDeadLetterSink
{
    private readonly ConcurrentQueue<DeadLetterEvent> events = new();
    public Task PublishAsync(DeadLetterEvent deadLetter, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        events.Enqueue(deadLetter);
        return Task.CompletedTask;
    }
    public Task<IReadOnlyList<DeadLetterEvent>> FindByTenantAsync(string tenantId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        IReadOnlyList<DeadLetterEvent> matches = events
            .Where(deadLetter => string.Equals(deadLetter.Event.TenantId, tenantId, StringComparison.Ordinal))
            .OrderBy(deadLetter => deadLetter.RecordedAt)
            .ToList();
        return Task.FromResult(matches);
    }
    public IReadOnlyList<DeadLetterEvent> Snapshot() => events.ToList();
}

public sealed class InMemoryMetricsSink : IMetricsSink
{
    private readonly ConcurrentDictionary<(string Tenant, string Name), long> counters = new();
    private readonly ConcurrentDictionary<(string Tenant, string Name), TimeSpan> timings = new();
    public void Increment(string name, string tenantId) => counters.AddOrUpdate((tenantId, name), 1L, (_, value) => value + 1L);
    public void Timing(string name, string tenantId, TimeSpan duration) => timings[(tenantId, name)] = duration;
    public MetricSnapshot Snapshot(string tenantId)
    {
        var tenantCounters = counters
            .Where(entry => string.Equals(entry.Key.Tenant, tenantId, StringComparison.Ordinal))
            .ToDictionary(entry => entry.Key.Name, entry => entry.Value, StringComparer.Ordinal);
        var tenantTimings = timings
            .Where(entry => string.Equals(entry.Key.Tenant, tenantId, StringComparison.Ordinal))
            .ToDictionary(entry => entry.Key.Name, entry => entry.Value, StringComparer.Ordinal);
        return new MetricSnapshot(tenantId, tenantCounters, tenantTimings);
    }
}

public sealed class InMemoryRetryableEventStore : IRetryableEventStore, IEventEnvelopeStore
{
    private readonly ConcurrentDictionary<string, PendingEvent> pending = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, EventEnvelope> envelopes = new(StringComparer.Ordinal);
    public Task<IReadOnlyList<PendingEvent>> FindDueAsync(DateTimeOffset now, int limit, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        IReadOnlyList<PendingEvent> due = pending.Values
            .Where(item => item.Retryable && item.RetryAfter <= now)
            .OrderBy(item => item.RetryAfter)
            .Take(limit)
            .ToList();
        return Task.FromResult(due);
    }
    public Task MarkRetryableAsync(PendingEvent pendingEvent, DateTimeOffset retryAfter, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        pending[Key(pendingEvent.Event.TenantId, pendingEvent.Event.EventId)] = pendingEvent with
        {
            RetryAfter = retryAfter,
            Retryable = true,
        };
        return Task.CompletedTask;
    }
    public Task<EventEnvelope?> FindAsync(string tenantId, string eventId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        envelopes.TryGetValue(Key(tenantId, eventId), out var envelope);
        return Task.FromResult<EventEnvelope?>(envelope);
    }
    public Task SaveAsync(EventEnvelope envelope, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        envelopes[Key(envelope.Event.TenantId, envelope.Event.EventId)] = envelope;
        return Task.CompletedTask;
    }
    public Task<IReadOnlyList<EventEnvelope>> FindByStageAsync(string tenantId, EventProcessingStage stage, int limit, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        IReadOnlyList<EventEnvelope> matches = envelopes.Values
            .Where(envelope => string.Equals(envelope.Event.TenantId, tenantId, StringComparison.Ordinal) && envelope.Stage == stage)
            .OrderBy(envelope => envelope.EnqueuedAt)
            .Take(limit)
            .ToList();
        return Task.FromResult(matches);
    }
    public void Add(PendingEvent item) => pending[Key(item.Event.TenantId, item.Event.EventId)] = item;
    private static string Key(string tenantId, string eventId) => tenantId + ":" + eventId;
}

public sealed class InMemoryWorkflowDispatcher : IWorkflowDispatcher
{
    private readonly ConcurrentQueue<AssetEvent> dispatched = new();
    private readonly Func<AssetEvent, DeliveryStatus>? behavior;
    public InMemoryWorkflowDispatcher(Func<AssetEvent, DeliveryStatus>? behavior = null) => this.behavior = behavior;
    public Task<DeliveryResult> DispatchAsync(AssetEvent assetEvent, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        dispatched.Enqueue(assetEvent);
        var status = behavior?.Invoke(assetEvent) ?? DeliveryStatus.Accepted;
        return Task.FromResult(new DeliveryResult(status == DeliveryStatus.Accepted, status));
    }
    public IReadOnlyList<AssetEvent> Snapshot() => dispatched.ToList();
}

public sealed class InMemoryDispatchHistory : IDispatchHistory, IDispatchAttemptStore
{
    private readonly ConcurrentQueue<DispatchAttempt> attempts = new();
    public Task AppendAsync(DispatchAttempt attempt, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        attempts.Enqueue(attempt);
        return Task.CompletedTask;
    }
    public Task<IReadOnlyList<DispatchAttempt>> FindAsync(string tenantId, string eventId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        IReadOnlyList<DispatchAttempt> matches = attempts
            .Where(attempt => string.Equals(attempt.TenantId, tenantId, StringComparison.Ordinal)
                && string.Equals(attempt.EventId, eventId, StringComparison.Ordinal))
            .OrderBy(attempt => attempt.Attempt)
            .ToList();
        return Task.FromResult(matches);
    }
    public IReadOnlyList<DispatchAttempt> Snapshot() => attempts.ToList();
}

public sealed class InMemoryOrderRepository : IOrderAggregateRepository
{
    private readonly ConcurrentDictionary<string, OrderSnapshot> snapshots = new(StringComparer.Ordinal);
    public Task<bool> ExistsAsync(string tenantId, string orderId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(snapshots.ContainsKey(Key(tenantId, orderId)));
    }
    public Task<OrderSnapshot?> FindAsync(string tenantId, string orderId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        snapshots.TryGetValue(Key(tenantId, orderId), out var snapshot);
        return Task.FromResult<OrderSnapshot?>(snapshot);
    }
    public Task SaveAsync(OrderSnapshot snapshot, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        snapshots[Key(snapshot.Request.TenantId, snapshot.Request.OrderId)] = snapshot;
        return Task.CompletedTask;
    }
    public IReadOnlyList<OrderSnapshot> Snapshot() => snapshots.Values.ToList();
    private static string Key(string tenantId, string orderId) => tenantId + ":" + orderId;
}


public sealed class InMemoryOrderRequestRepository : IOrderRepository
{
    private readonly ConcurrentDictionary<string, OrderRequest> requests = new(StringComparer.Ordinal);
    public Task<OrderRequest?> FindAsync(string tenantId, string orderId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        requests.TryGetValue(Key(tenantId, orderId), out var request);
        return Task.FromResult<OrderRequest?>(request);
    }
    public Task SaveAsync(OrderRequest order, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        requests[Key(order.TenantId, order.OrderId)] = order;
        return Task.CompletedTask;
    }
    public Task<bool> ExistsAsync(string tenantId, string orderId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(requests.ContainsKey(Key(tenantId, orderId)));
    }
    private static string Key(string tenantId, string orderId) => tenantId + ":" + orderId;
}

public sealed class InMemoryInventoryGateway : IInventoryGateway, IReservationLedger
{
    private static readonly TimeSpan ReservationLifetime = TimeSpan.FromMinutes(15);
    private readonly ConcurrentDictionary<string, InventoryReservation> reservations = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, int> stock = new(StringComparer.OrdinalIgnoreCase);
    private readonly object stockGate = new();
    private readonly IClock clock;
    public InMemoryInventoryGateway(IClock? clock = null) => this.clock = clock ?? new SystemClock();
    public void Seed(string sku, int quantity)
    {
        lock (stockGate)
        {
            stock[sku] = quantity;
        }
    }
    public Task<ReservationResult> ReserveAsync(OrderRequest order, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var required = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in order.Lines)
        {
            required[line.Sku] = required.TryGetValue(line.Sku, out var current) ? current + line.Quantity : line.Quantity;
        }

        lock (stockGate)
        {
            foreach (var (sku, quantity) in required)
            {
                var available = stock.TryGetValue(sku, out var onHand) ? onHand : 0;
                if (quantity > available)
                {
                    return Task.FromResult(new ReservationResult(false, null, $"insufficient stock for '{sku}'"));
                }
            }

            foreach (var (sku, quantity) in required)
            {
                stock[sku] = (stock.TryGetValue(sku, out var onHand) ? onHand : 0) - quantity;
            }
        }

        var reservationId = Guid.NewGuid().ToString("N");
        var reservation = new InventoryReservation(
            reservationId,
            order.TenantId,
            order.OrderId,
            required,
            clock.UtcNow + ReservationLifetime,
            false);
        reservations[Key(order.TenantId, reservationId)] = reservation;
        return Task.FromResult(new ReservationResult(true, reservationId));
    }
    public Task<InventoryReservation?> FindAsync(string tenantId, string reservationId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        reservations.TryGetValue(Key(tenantId, reservationId), out var reservation);
        return Task.FromResult<InventoryReservation?>(reservation);
    }
    public Task SaveAsync(InventoryReservation reservation, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        reservations[Key(reservation.TenantId, reservation.ReservationId)] = reservation;
        return Task.CompletedTask;
    }
    public Task ReleaseAsync(string tenantId, string reservationId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var key = Key(tenantId, reservationId);
        if (reservations.TryGetValue(key, out var reservation) && !reservation.Released)
        {
            lock (stockGate)
            {
                foreach (var (sku, quantity) in reservation.Quantities)
                {
                    stock[sku] = (stock.TryGetValue(sku, out var onHand) ? onHand : 0) + quantity;
                }
            }

            reservations[key] = reservation with { Released = true };
        }

        return Task.CompletedTask;
    }
    private static string Key(string tenantId, string reservationId) => tenantId + ":" + reservationId;
}

public sealed class InMemoryOrderCommitter : IOrderCommitter
{
    private readonly ConcurrentQueue<OrderCommitReceipt> receipts = new();
    private readonly IClock clock;
    public InMemoryOrderCommitter(IClock? clock = null) => this.clock = clock ?? new SystemClock();
    public Task CommitAsync(OrderRequest order, ReservationResult reservation, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var receipt = new OrderCommitReceipt(
            order.OrderId,
            reservation.ReservationId ?? string.Empty,
            Guid.NewGuid().ToString("N"),
            clock.UtcNow);
        receipts.Enqueue(receipt);
        return Task.CompletedTask;
    }
    public IReadOnlyList<OrderCommitReceipt> Snapshot() => receipts.ToList();
}

public sealed class InMemoryPluginRegistry : IPluginRegistry
{
    private readonly ConcurrentDictionary<string, PluginDescriptor> plugins = new(StringComparer.Ordinal);
    public Task RegisterAsync(PluginDescriptor descriptor, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        plugins[Key(descriptor.TenantId, descriptor.PluginId)] = descriptor;
        return Task.CompletedTask;
    }
    public Task<PluginDescriptor?> FindCapabilityAsync(string tenantId, string capability, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var match = plugins.Values
            .Where(descriptor => string.Equals(descriptor.TenantId, tenantId, StringComparison.Ordinal))
            .Where(descriptor => descriptor.Enabled && descriptor.Capabilities.Contains(capability))
            .OrderBy(descriptor => descriptor.PluginId, StringComparer.Ordinal)
            .FirstOrDefault();
        return Task.FromResult<PluginDescriptor?>(match);
    }
    public Task<IReadOnlyList<PluginDescriptor>> ListAsync(string tenantId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        IReadOnlyList<PluginDescriptor> descriptors = plugins.Values
            .Where(descriptor => string.Equals(descriptor.TenantId, tenantId, StringComparison.Ordinal))
            .OrderBy(descriptor => descriptor.PluginId, StringComparer.Ordinal)
            .ToList();
        return Task.FromResult(descriptors);
    }
    private static string Key(string tenantId, string pluginId) => tenantId + ":" + pluginId;
}

public sealed class InMemoryTransactionBoundary : ITransactionBoundary
{
    private readonly SemaphoreSlim gate = new(1, 1);
    public async Task<T> ExecuteAsync<T>(Func<CancellationToken, Task<T>> operation, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return await operation(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            gate.Release();
        }
    }
}

public sealed class InMemoryLeaseStore : ILeaseStore
{
    private readonly ConcurrentDictionary<string, LeaseClaim> claims = new(StringComparer.Ordinal);
    private readonly object gate = new();
    public Task<bool> TryClaimAsync(string tenantId, string key, TimeSpan duration, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var composite = Key(tenantId, key);
        var now = DateTimeOffset.UtcNow;
        lock (gate)
        {
            if (claims.TryGetValue(composite, out var existing) && existing.ExpiresAt > now)
            {
                return Task.FromResult(false);
            }

            claims[composite] = new LeaseClaim(tenantId, key, now + duration, "in-memory");
            return Task.FromResult(true);
        }
    }
    public Task ReleaseAsync(string tenantId, string key, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        claims.TryRemove(Key(tenantId, key), out _);
        return Task.CompletedTask;
    }
    private static string Key(string tenantId, string key) => tenantId + ":" + key;
}

public sealed class InMemoryCheckpointStore : ICheckpointStore
{
    private readonly ConcurrentDictionary<string, string> values = new(StringComparer.Ordinal);
    public Task<string?> GetAsync(string tenantId, string jobName, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        values.TryGetValue(Key(tenantId, jobName), out var checkpoint);
        return Task.FromResult(checkpoint);
    }
    public Task PutAsync(string tenantId, string jobName, string checkpoint, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        values[Key(tenantId, jobName)] = checkpoint;
        return Task.CompletedTask;
    }
    private static string Key(string tenantId, string jobName) => tenantId + ":" + jobName;
}

public sealed class InMemoryQuarantineLog : IQuarantineLog
{
    private readonly ConcurrentQueue<QuarantineEntry> entries = new();
    public Task RecordAsync(string tenantId, string attachmentId, IReadOnlyList<ValidationIssue> issues, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        entries.Enqueue(new QuarantineEntry(
            tenantId,
            attachmentId,
            issues ?? Array.Empty<ValidationIssue>(),
            DateTimeOffset.UtcNow));
        return Task.CompletedTask;
    }
    public Task<IReadOnlyList<string>> FindAsync(string tenantId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        IReadOnlyList<string> attachmentIds = entries
            .Where(entry => string.Equals(entry.TenantId, tenantId, StringComparison.Ordinal))
            .Select(entry => entry.AttachmentId)
            .Distinct(StringComparer.Ordinal)
            .ToList();
        return Task.FromResult(attachmentIds);
    }
}

public sealed class InMemoryFeatureFlags : IFeatureFlags
{
    private readonly ConcurrentDictionary<(string Tenant, string Flag), bool> flags = new();
    public void Set(string tenantId, string flag, bool enabled) => flags[(tenantId, flag)] = enabled;
    public bool Enabled(string tenantId, string flag) => flags.TryGetValue((tenantId, flag), out var enabled) && enabled;
}
