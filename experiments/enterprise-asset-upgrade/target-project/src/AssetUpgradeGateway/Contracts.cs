namespace AssetUpgradeGateway;

public sealed record AssetEvent(
    string EventId,
    string TenantId,
    string AssetId,
    string EventType,
    DateTimeOffset CreatedAt,
    string? AttachmentId = null);

public sealed record AttachmentInput(
    string AttachmentId,
    string TenantId,
    string FileName,
    string DeclaredContentType,
    ReadOnlyMemory<byte> Content,
    bool Scanned);

public sealed record DeliveryResult(bool Accepted, string Status, string? Detail = null);

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
    bool HasCompleted(string tenantId, string eventId);
    void MarkCompleted(string tenantId, string eventId);
}

public interface IAuditSink
{
    void Record(string tenantId, string eventId, string action, string status);
}

public sealed class AssetUpgradeService(
    ITenantAuthorizer authorizer,
    IAttachmentQuarantine quarantine,
    IWorkflowDispatcher dispatcher,
    IIdempotencyStore idempotency,
    IAuditSink audit)
{
    public async Task<DeliveryResult> SubmitAsync(
        string actorId,
        AssetEvent assetEvent,
        AttachmentInput? attachment,
        CancellationToken cancellationToken = default)
    {
        throw new NotImplementedException("The benchmark agent must implement this workflow.");
    }
}
