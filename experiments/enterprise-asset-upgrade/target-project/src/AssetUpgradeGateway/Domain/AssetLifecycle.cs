namespace AssetUpgradeGateway.Domain;

using AssetUpgradeGateway;

/// <summary>
/// Domain vocabulary reconstructed from the file-upload, identity and workflow
/// assets. The target uses its own names so an implementation must translate
/// concepts instead of copying an upstream API.
/// </summary>
public enum AssetKind
{
    Document,
    Image,
    Archive,
    DataExport,
    PluginPackage,
}

public enum AttachmentInspectionState
{
    Received,
    Quarantined,
    Scanning,
    Clean,
    Rejected,
    Released,
}

public enum EventProcessingStage
{
    Created,
    Authorized,
    Validated,
    Enqueued,
    Delivered,
    RetryScheduled,
    DeadLettered,
    Completed,
}

public sealed record AssetDescriptor
{
    public AssetDescriptor(string assetId, string tenantId, AssetKind kind, string externalKey)
        : this(assetId, tenantId, kind, externalKey, new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)) { }

    public AssetDescriptor(string assetId, string tenantId, AssetKind kind, string externalKey, IReadOnlyDictionary<string, string>? tags)
    {
        if (string.IsNullOrWhiteSpace(assetId)) throw new ArgumentException("Asset id is required.", nameof(assetId));
        if (string.IsNullOrWhiteSpace(tenantId)) throw new ArgumentException("Tenant id is required.", nameof(tenantId));
        if (string.IsNullOrWhiteSpace(externalKey)) throw new ArgumentException("External key is required.", nameof(externalKey));
        AssetId = assetId; TenantId = tenantId; Kind = kind; ExternalKey = externalKey;
        Tags = tags is null ? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) : new Dictionary<string, string>(tags, StringComparer.OrdinalIgnoreCase);
    }

    public string AssetId { get; init; }
    public string TenantId { get; init; }
    public AssetKind Kind { get; init; }
    public string ExternalKey { get; init; }
    public IReadOnlyDictionary<string, string> Tags { get; init; }

    public bool HasTag(string key) => Tags.ContainsKey(key);

    public AssetDescriptor WithTag(string key, string value)
    {
        var tags = new Dictionary<string, string>(Tags, StringComparer.OrdinalIgnoreCase) { [key] = value };
        return this with { Tags = tags };
    }
}

public sealed record AttachmentMetadata(
    string AttachmentId,
    string TenantId,
    string FileName,
    string DeclaredContentType,
    long Length,
    string? ContentHash,
    AttachmentInspectionState InspectionState,
    DateTimeOffset ReceivedAt,
    DateTimeOffset? ScannedAt,
    string? RejectionReason)
{
    public bool IsTerminal => InspectionState is AttachmentInspectionState.Released or AttachmentInspectionState.Rejected;

    public bool IsUsable => InspectionState is AttachmentInspectionState.Clean or AttachmentInspectionState.Released;

    public AttachmentMetadata Quarantine() => this with { InspectionState = AttachmentInspectionState.Quarantined };

    public AttachmentMetadata BeginScan(DateTimeOffset now) => this with
    {
        InspectionState = AttachmentInspectionState.Scanning,
        ScannedAt = now,
        RejectionReason = null,
    };

    public AttachmentMetadata MarkClean(DateTimeOffset now) => this with
    {
        InspectionState = AttachmentInspectionState.Clean,
        ScannedAt = now,
        RejectionReason = null,
    };

    public AttachmentMetadata Reject(string reason) => this with
    {
        InspectionState = AttachmentInspectionState.Rejected,
        RejectionReason = reason,
    };

    public AttachmentMetadata Release() => IsUsable
        ? this with { InspectionState = AttachmentInspectionState.Released }
        : throw new InvalidOperationException("Only a clean attachment can be released.");
}

public sealed record ContentSignature(
    string MediaType,
    IReadOnlyList<byte> Prefix,
    IReadOnlyList<string> AllowedExtensions,
    bool IsText)
{
    public bool Matches(ReadOnlySpan<byte> content)
    {
        if (Prefix.Count == 0) return IsText;
        if (content.Length < Prefix.Count) return false;
        for (var index = 0; index < Prefix.Count; index++)
        {
            if (content[index] != Prefix[index]) return false;
        }
        return true;
    }
}

public sealed record TenantScope(
    string TenantId,
    string ActorId,
    IReadOnlySet<string> Roles,
    IReadOnlySet<string> Permissions,
    DateTimeOffset ExpiresAt)
{
    public bool IsExpired(DateTimeOffset now) => now >= ExpiresAt;

    public bool HasRole(string role) => Roles.Contains(role);

    public bool Can(string permission) => Permissions.Contains(permission);

    public TenantScope RequireTenant(string tenantId)
        => string.Equals(TenantId, tenantId, StringComparison.Ordinal)
            ? this
            : throw new UnauthorizedAccessException("Tenant scope mismatch.");
}

public sealed class AssetAggregate
{
    private readonly List<AttachmentMetadata> attachments = [];
    private readonly List<AssetEvent> events = [];

    public AssetAggregate(AssetDescriptor descriptor)
    {
        Descriptor = descriptor ?? throw new ArgumentNullException(nameof(descriptor));
    }

    public AssetDescriptor Descriptor { get; private set; }

    public IReadOnlyList<AttachmentMetadata> Attachments => attachments;

    public IReadOnlyList<AssetEvent> Events => events;

    public void AddAttachment(AttachmentMetadata attachment)
    {
        if (!string.Equals(attachment.TenantId, Descriptor.TenantId, StringComparison.Ordinal))
            throw new UnauthorizedAccessException("Attachment belongs to another tenant.");
        if (attachments.Any(item => item.AttachmentId == attachment.AttachmentId))
            throw new InvalidOperationException("Attachment is already attached to this asset.");
        attachments.Add(attachment);
    }

    public void RecordEvent(AssetEvent assetEvent)
    {
        if (assetEvent.TenantId != Descriptor.TenantId || assetEvent.AssetId != Descriptor.AssetId)
            throw new InvalidOperationException("Event does not belong to the aggregate.");
        if (events.Any(item => item.EventId == assetEvent.EventId)) return;
        events.Add(assetEvent);
    }

    public void RenameExternalKey(string externalKey)
    {
        if (string.IsNullOrWhiteSpace(externalKey)) throw new ArgumentException("External key is required.", nameof(externalKey));
        Descriptor = Descriptor with { ExternalKey = externalKey };
    }
}

public sealed record EventEnvelope(
    AssetEvent Event,
    string CorrelationId,
    string CausationId,
    int DeliveryAttempt,
    EventProcessingStage Stage,
    DateTimeOffset EnqueuedAt,
    DateTimeOffset? DeliveredAt,
    IReadOnlyDictionary<string, string> Headers)
{
    public EventEnvelope(AssetEvent assetEvent, string correlationId)
        : this(assetEvent, correlationId, assetEvent.EventId, 0, EventProcessingStage.Created,
            assetEvent.CreatedAt, null, new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)) { }

    public EventEnvelope NextAttempt(DateTimeOffset now) => this with
    {
        DeliveryAttempt = DeliveryAttempt + 1,
        Stage = EventProcessingStage.RetryScheduled,
        EnqueuedAt = now,
    };

    public EventEnvelope MarkDelivered(DateTimeOffset now) => this with
    {
        Stage = EventProcessingStage.Delivered,
        DeliveredAt = now,
    };

    public EventEnvelope WithHeader(string name, string value)
    {
        var headers = new Dictionary<string, string>(Headers, StringComparer.OrdinalIgnoreCase) { [name] = value };
        return this with { Headers = headers };
    }
}

public sealed record AssetPage<T>(
    IReadOnlyList<T> Items,
    string? ContinuationToken,
    int TotalCount,
    bool HasMore)
{
    public static AssetPage<T> Empty => new([], null, 0, false);
}
