namespace AssetUpgradeGateway;

public enum DeliveryStatus { Accepted, Rejected, Retryable, Duplicate, Quarantined }

public enum OrderStatus { Accepted, Rejected, RolledBack }

public sealed record AssetEvent(
    string EventId,
    string TenantId,
    string AssetId,
    string EventType,
    DateTimeOffset CreatedAt,
    string? AttachmentId = null)
{
    // Kept as an init property so existing six-argument fixtures remain valid.
    public WorkflowState State { get; init; }
}

public sealed record AttachmentInput(
    string AttachmentId,
    string TenantId,
    string FileName,
    string DeclaredContentType,
    ReadOnlyMemory<byte> Content,
    bool Scanned);

public sealed record DeliveryResult(bool Accepted, DeliveryStatus Status, string? Detail = null);

public sealed record PendingEvent(
    AssetEvent Event,
    DateTimeOffset RetryAfter,
    int Attempts,
    bool Retryable);

public sealed record ReconciliationReport(
    int Examined,
    int Retried,
    int Succeeded,
    int Failed,
    IReadOnlyList<string> EventIds);

public sealed record OrderRequest(
    string OrderId,
    string TenantId,
    string ActorId,
    IReadOnlyList<OrderLine> Lines,
    string Currency);

public sealed record OrderLine(string Sku, int Quantity, long UnitPriceMinor);

public sealed record ReservationResult(bool Reserved, string? ReservationId, string? Detail = null);

public sealed record OrderResult(
    bool Accepted,
    OrderStatus Status,
    string? ReservationId = null,
    string? Detail = null);

public sealed record AuditRecord(
    string TenantId,
    string SubjectId,
    string Action,
    string Status,
    DateTimeOffset At);

// Flow-production contracts translate the historical FlowProducer vocabulary
// into the gateway's tenant-scoped, domain-neutral terms. A node with children
// is produced as a parent that waits for its children to complete.
public sealed record WorkflowFlowOptions(
    string? OperationId = null,
    TimeSpan? Delay = null,
    int? MaxAttempts = null,
    string? CorrelationId = null);

public sealed record WorkflowFlowNode(
    string TenantId,
    AssetEvent Event,
    WorkflowFlowOptions? Options = null,
    IReadOnlyList<WorkflowFlowNode>? Children = null)
{
    public bool IsParent => Children is { Count: > 0 };
}

// Event-model contracts translated from the historical Nop.Core.Events module.
// The gateway keeps its tenant-scoped, timestamped vocabulary: the three
// entity notifications collapse into one tenant-scoped change notification, and
// the mutating stop signal is preserved for consumers that observe publishing.
public interface IStopProcessingEvent
{
    bool StopProcessing { get; set; }
}

public sealed record AppStartedEvent(DateTimeOffset StartedAtUtc);

public enum EntityChangeKind { Inserted, Updated, Deleted }

public sealed record EntityChangedEvent<T>(
    string TenantId,
    T Entity,
    EntityChangeKind Kind,
    DateTimeOffset OccurredAt) : IStopProcessingEvent
{
    public bool StopProcessing { get; set; }
}
