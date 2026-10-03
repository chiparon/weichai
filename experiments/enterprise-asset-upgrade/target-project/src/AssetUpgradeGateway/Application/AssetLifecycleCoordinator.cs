namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;

public sealed record AssetSubmissionCommand(string TenantId, string ActorId, AssetDescriptor Descriptor, AttachmentInput? Attachment, string EventType, string CorrelationId);
public sealed record AssetSubmissionResult(bool Accepted, DeliveryResult Delivery, AttachmentState? AttachmentState, IReadOnlyList<ValidationIssue> Issues);

public sealed class AssetLifecycleCoordinator
{
    private readonly AttachmentIntakeService attachments;
    private readonly WorkflowDeliveryCoordinator workflow;
    private readonly IAssetRepository assets;
    private readonly IAuditSink audit;
    private readonly IClock clock;

    public AssetLifecycleCoordinator(AttachmentIntakeService attachments, WorkflowDeliveryCoordinator workflow, IAssetRepository assets, IAuditSink audit, IClock? clock = null)
    {
        this.attachments = attachments; this.workflow = workflow; this.assets = assets; this.audit = audit; this.clock = clock ?? new Adapters.SystemClock();
    }

    public async Task<AssetSubmissionResult> SubmitAsync(AssetSubmissionCommand command, CancellationToken cancellationToken = default)
    {
        var aggregate = await assets.FindAsync(command.TenantId, command.Descriptor.AssetId, cancellationToken) ?? new AssetAggregate(command.Descriptor);
        AttachmentState? state = null;
        var issues = new List<ValidationIssue>();
        if (command.Attachment is not null)
        {
            var intake = await attachments.IntakeAsync(new(command.TenantId, command.ActorId, command.Attachment, command.CorrelationId), cancellationToken);
            state = intake.State;
            issues.AddRange(intake.Issues.Where(x => x.BlocksOperation));
            if (!intake.Accepted) return new(false, new(false, DeliveryStatus.Quarantined, "Attachment intake failed."), state, issues);
            aggregate.AddAttachment(new AttachmentMetadata(command.Attachment.AttachmentId, command.TenantId, command.Attachment.FileName, command.Attachment.DeclaredContentType, command.Attachment.Content.Length, command.Attachment.StableFingerprint(), AttachmentInspectionState.Released, clock.UtcNow, clock.UtcNow, null));
        }
        var assetEvent = new AssetEvent($"asset-event-{Guid.NewGuid():N}", command.TenantId, command.Descriptor.AssetId, command.EventType, clock.UtcNow, command.Attachment?.AttachmentId) { State = WorkflowState.Approved };
        aggregate.RecordEvent(assetEvent);
        await assets.SaveAsync(aggregate, cancellationToken);
        var delivery = await workflow.DeliverAsync(new(command.TenantId, command.ActorId, assetEvent, command.CorrelationId), cancellationToken);
        audit.Record(new(command.TenantId, command.Descriptor.AssetId, "asset.submit", delivery.Accepted ? "accepted" : "rejected", clock.UtcNow));
        return new(delivery.Accepted, new(delivery.Accepted, delivery.Status, delivery.Accepted ? null : "Workflow delivery did not complete."), state, issues.Concat(delivery.Issues).ToArray());
    }
}

public sealed class AssetSearchService
{
    private readonly IAssetRepository assets;
    private readonly ITenantAuthorizer authorizer;
    public AssetSearchService(IAssetRepository assets, ITenantAuthorizer authorizer) { this.assets = assets; this.authorizer = authorizer; }
    public Task<AssetPage<AssetAggregate>> SearchAsync(string tenantId, string actorId, string? token, int pageSize, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId)) throw new UnauthorizedAccessException("Actor cannot search tenant assets.");
        if (pageSize is < 1 or > 500) throw new ArgumentOutOfRangeException(nameof(pageSize));
        return assets.SearchAsync(tenantId, token, pageSize, cancellationToken);
    }
}

public sealed class InMemoryAssetRepository : IAssetRepository
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, AssetAggregate> values = new(StringComparer.Ordinal);
    public Task<AssetAggregate?> FindAsync(string tenantId, string assetId, CancellationToken cancellationToken)
    {
        values.TryGetValue(Key(tenantId, assetId), out var value);
        return Task.FromResult(value);
    }
    public Task SaveAsync(AssetAggregate asset, CancellationToken cancellationToken) { values[Key(asset.Descriptor.TenantId, asset.Descriptor.AssetId)] = asset; return Task.CompletedTask; }
    public Task<AssetPage<AssetAggregate>> SearchAsync(string tenantId, string? continuationToken, int pageSize, CancellationToken cancellationToken)
    {
        var all = values.Values.Where(x => x.Descriptor.TenantId == tenantId).OrderBy(x => x.Descriptor.AssetId, StringComparer.Ordinal).ToArray();
        var start = int.TryParse(continuationToken, out var offset) ? offset : 0;
        var items = all.Skip(start).Take(pageSize).ToArray();
        var next = start + items.Length < all.Length ? (start + items.Length).ToString() : null;
        return Task.FromResult(new AssetPage<AssetAggregate>(items, next, all.Length, next is not null));
    }
    private static string Key(string tenantId, string assetId) => tenantId + ":" + assetId;
}

public sealed class AssetEventFactory
{
    private readonly IClock clock;
    public AssetEventFactory(IClock? clock = null) => this.clock = clock ?? new Adapters.SystemClock();
    public AssetEvent Create(AssetDescriptor descriptor, string eventType, string? attachmentId = null) => new($"evt-{Guid.NewGuid():N}", descriptor.TenantId, descriptor.AssetId, eventType, clock.UtcNow, attachmentId) { State = WorkflowState.New };
    public EventEnvelope Envelop(AssetEvent assetEvent, string correlationId, string actorId) => new(assetEvent, correlationId).WithHeader("actor", actorId).WithHeader("schema", "asset-event.v2");
}
