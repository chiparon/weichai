namespace AssetUpgradeGateway;

public interface ITenantAuthorizer
{
    bool CanAccess(string tenantId, string actorId);
}

public interface IAttachmentQuarantine
{
    bool IsSafe(AttachmentInput attachment);
}

public interface IWorkflowDispatcher
{
    Task<DeliveryResult> DispatchAsync(AssetEvent assetEvent, CancellationToken cancellationToken);
}

public interface IIdempotencyStore
{
    bool HasCompleted(string tenantId, string operationId);
    void MarkCompleted(string tenantId, string operationId);
}

public interface IAuditSink
{
    void Record(AuditRecord record);
}

public interface IRetryableEventStore
{
    Task<IReadOnlyList<PendingEvent>> FindDueAsync(
        DateTimeOffset now,
        int limit,
        CancellationToken cancellationToken);

    Task MarkRetryableAsync(
        PendingEvent pending,
        DateTimeOffset retryAfter,
        CancellationToken cancellationToken);
}

public interface IOrderValidator
{
    bool IsValid(OrderRequest order, out string? reason);
}

public interface IInventoryGateway
{
    Task<ReservationResult> ReserveAsync(
        OrderRequest order,
        CancellationToken cancellationToken);
}

/// The implementation owns the database transaction. The Agent must call this
/// only after validation and reservation have succeeded.
public interface IOrderCommitter
{
    Task CommitAsync(
        OrderRequest order,
        ReservationResult reservation,
        CancellationToken cancellationToken);
}

/// <summary>
/// Application-facing flow boundary preserving the historical FlowProducer.AddAsync
/// behavior: a whole node tree is produced atomically. Leaf dispatch delegates to
/// the unchanged <see cref="IWorkflowDispatcher.DispatchAsync"/> and atomicity to
/// <see cref="ITransactionBoundary"/>; observability uses <see cref="IMetricsSink"/>.
/// </summary>
public interface IWorkflowFlowProducer
{
    Task<WorkflowFlowResult> ProduceAsync(WorkflowFlowNode flow, CancellationToken cancellationToken);
}

/// <summary>
/// Publish boundary translated from the historical IEventPublisher. Every gateway
/// port takes a <see cref="CancellationToken"/>, so it is the final parameter here.
/// </summary>
public interface IEventPublisher
{
    Task PublishAsync<TEvent>(TEvent @event, CancellationToken cancellationToken);
}

/// <summary>
/// Asset-oriented publish helpers preserving the historical EventPublisherExtensions
/// behavior. The entity helpers translate to a single tenant-scoped
/// <see cref="EntityChangedEvent{T}"/>; the <see cref="AssetEvent"/> overloads derive
/// tenant and time from the event itself.
/// </summary>
public static class EventPublisherExtensions
{
    public static Task AssetInsertedAsync<T>(
        this IEventPublisher publisher,
        T entity,
        string tenantId,
        CancellationToken cancellationToken = default)
        => publisher.PublishAsync(
            new EntityChangedEvent<T>(tenantId, entity, EntityChangeKind.Inserted, DateTimeOffset.UtcNow),
            cancellationToken);

    public static Task AssetUpdatedAsync<T>(
        this IEventPublisher publisher,
        T entity,
        string tenantId,
        CancellationToken cancellationToken = default)
        => publisher.PublishAsync(
            new EntityChangedEvent<T>(tenantId, entity, EntityChangeKind.Updated, DateTimeOffset.UtcNow),
            cancellationToken);

    public static Task AssetDeletedAsync<T>(
        this IEventPublisher publisher,
        T entity,
        string tenantId,
        CancellationToken cancellationToken = default)
        => publisher.PublishAsync(
            new EntityChangedEvent<T>(tenantId, entity, EntityChangeKind.Deleted, DateTimeOffset.UtcNow),
            cancellationToken);

    public static Task AssetInsertedAsync(
        this IEventPublisher publisher,
        AssetEvent assetEvent,
        CancellationToken cancellationToken = default)
        => publisher.PublishAsync(
            new EntityChangedEvent<AssetEvent>(assetEvent.TenantId, assetEvent, EntityChangeKind.Inserted, assetEvent.CreatedAt),
            cancellationToken);

    public static Task AssetUpdatedAsync(
        this IEventPublisher publisher,
        AssetEvent assetEvent,
        CancellationToken cancellationToken = default)
        => publisher.PublishAsync(
            new EntityChangedEvent<AssetEvent>(assetEvent.TenantId, assetEvent, EntityChangeKind.Updated, assetEvent.CreatedAt),
            cancellationToken);

    public static Task AssetDeletedAsync(
        this IEventPublisher publisher,
        AssetEvent assetEvent,
        CancellationToken cancellationToken = default)
        => publisher.PublishAsync(
            new EntityChangedEvent<AssetEvent>(assetEvent.TenantId, assetEvent, EntityChangeKind.Deleted, assetEvent.CreatedAt),
            cancellationToken);
}
