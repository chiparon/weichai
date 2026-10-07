namespace AssetUpgradeGateway.Application;

using System.Collections.Concurrent;
using System.Globalization;
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
        ArgumentNullException.ThrowIfNull(command);
        cancellationToken.ThrowIfCancellationRequested();

        var descriptor = command.Descriptor is null
            ? throw new ArgumentException("Asset descriptor is required.", nameof(command))
            : command.Descriptor with
            {
                AssetId = (command.Descriptor.AssetId ?? string.Empty).Trim(),
                TenantId = (command.Descriptor.TenantId ?? string.Empty).Trim(),
                ExternalKey = (command.Descriptor.ExternalKey ?? string.Empty).Trim(),
            };
        var factory = new AssetEventFactory(clock);
        var attachment = command.Attachment is null ? null : new RequestNormalizer().Normalize(command.Attachment);

        AttachmentIntakeResult? intake = null;
        if (attachment is not null)
        {
            intake = await attachments
                .IntakeAsync(new AttachmentIntakeCommand(command.TenantId, command.ActorId, attachment, command.CorrelationId), cancellationToken)
                .ConfigureAwait(false);

            if (!intake.Accepted)
            {
                var rejected = new DeliveryResult(false, DeliveryStatus.Quarantined, intake.Issues.FirstOrDefault()?.Message);
                return new AssetSubmissionResult(false, rejected, intake.State, intake.Issues);
            }
        }

        var assetEvent = factory.Create(descriptor, command.EventType, attachment?.AttachmentId);
        var envelopeEvent = factory.Envelop(assetEvent, command.CorrelationId, command.ActorId).Event;
        var delivery = await workflow
            .DeliverAsync(new WorkflowDeliveryCommand(command.TenantId, command.ActorId, envelopeEvent, command.CorrelationId), cancellationToken)
            .ConfigureAwait(false);

        if (!delivery.Accepted)
        {
            var rejected = new DeliveryResult(false, delivery.Status, delivery.Issues.FirstOrDefault()?.Message);
            return new AssetSubmissionResult(false, rejected, null, delivery.Issues);
        }

        var aggregate = await assets.FindAsync(command.TenantId, descriptor.AssetId, cancellationToken).ConfigureAwait(false)
            ?? new AssetAggregate(descriptor);

        if (attachment is not null && intake is not null)
        {
            var now = clock.UtcNow;
            var metadata = new AttachmentMetadata(
                attachment.AttachmentId,
                attachment.TenantId,
                attachment.FileName,
                attachment.DeclaredContentType,
                attachment.Content.Length,
                intake.Fingerprint,
                AttachmentInspectionState.Clean,
                now,
                now,
                null);
            aggregate.AddAttachment(metadata);
        }

        aggregate.RecordEvent(assetEvent.WithState(delivery.State));
        aggregate.RenameExternalKey(descriptor.ExternalKey);
        await assets.SaveAsync(aggregate, cancellationToken).ConfigureAwait(false);
        audit.Record(new AuditRecord(command.TenantId, descriptor.AssetId, "asset.submit", delivery.State.ToString().ToLowerInvariant(), clock.UtcNow));

        return new AssetSubmissionResult(true, new DeliveryResult(true, delivery.Status), attachment is null ? null : AttachmentState.Scanned, Array.Empty<ValidationIssue>());
    }
}

public sealed class AssetSearchService
{
    private const int DefaultPageSize = 50;
    private const int MaximumPageSize = 200;

    private readonly IAssetRepository assets;
    private readonly ITenantAuthorizer authorizer;
    public AssetSearchService(IAssetRepository assets, ITenantAuthorizer authorizer) { this.assets = assets; this.authorizer = authorizer; }

    public async Task<AssetPage<AssetAggregate>> SearchAsync(string tenantId, string actorId, string? token, int pageSize, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId))
        {
            return AssetPage<AssetAggregate>.Empty;
        }

        var size = pageSize <= 0 ? DefaultPageSize : Math.Min(pageSize, MaximumPageSize);
        return await assets.SearchAsync(tenantId, token, size, cancellationToken).ConfigureAwait(false);
    }
}

public sealed class InMemoryAssetRepository : IAssetRepository
{
    private const int DefaultPageSize = 50;
    private const int MaximumPageSize = 200;

    private readonly ConcurrentDictionary<string, AssetAggregate> values = new(StringComparer.Ordinal);

    public Task<AssetAggregate?> FindAsync(string tenantId, string assetId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        values.TryGetValue(Key(tenantId, assetId), out var asset);
        return Task.FromResult<AssetAggregate?>(asset);
    }

    public Task SaveAsync(AssetAggregate asset, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(asset);
        cancellationToken.ThrowIfCancellationRequested();
        values[Key(asset.Descriptor.TenantId, asset.Descriptor.AssetId)] = asset;
        return Task.CompletedTask;
    }

    public Task<AssetPage<AssetAggregate>> SearchAsync(string tenantId, string? continuationToken, int pageSize, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var all = values.Values
            .Where(asset => string.Equals(asset.Descriptor.TenantId, tenantId, StringComparison.Ordinal))
            .OrderBy(asset => asset.Descriptor.AssetId, StringComparer.Ordinal)
            .ToList();

        var start = 0;
        if (!string.IsNullOrEmpty(continuationToken)
            && int.TryParse(continuationToken, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
            && parsed > 0)
        {
            start = parsed;
        }

        var size = pageSize <= 0 ? DefaultPageSize : Math.Min(pageSize, MaximumPageSize);
        var page = new List<AssetAggregate>();
        for (var index = start; index < all.Count && page.Count < size; index++)
        {
            page.Add(all[index]);
        }

        var next = start + page.Count;
        var hasMore = next < all.Count;
        var nextToken = hasMore ? next.ToString(CultureInfo.InvariantCulture) : null;
        return Task.FromResult(new AssetPage<AssetAggregate>(page, nextToken, all.Count, hasMore));
    }

    private static string Key(string tenantId, string assetId) => tenantId + ":" + assetId;
}

public sealed class AssetEventFactory
{
    private readonly IClock clock;
    public AssetEventFactory(IClock? clock = null) => this.clock = clock ?? new Adapters.SystemClock();

    public AssetEvent Create(AssetDescriptor descriptor, string eventType, string? attachmentId = null)
    {
        ArgumentNullException.ThrowIfNull(descriptor);
        return new AssetEvent(
            Guid.NewGuid().ToString("N"),
            descriptor.TenantId,
            descriptor.AssetId,
            eventType,
            clock.UtcNow,
            attachmentId);
    }

    public EventEnvelope Envelop(AssetEvent assetEvent, string correlationId, string actorId)
    {
        ArgumentNullException.ThrowIfNull(assetEvent);
        return new EventEnvelope(assetEvent, correlationId).WithHeader("actorId", actorId);
    }
}
