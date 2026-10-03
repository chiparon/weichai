namespace AssetUpgradeGateway.Policies;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;

public sealed record QuotaSnapshot(string TenantId, long BytesUsed, int AttachmentsUsed, int EventsUsed, DateTimeOffset WindowStarted);

public sealed class TenantQuotaPolicy
{
    private readonly long byteLimit;
    private readonly int attachmentLimit;
    private readonly int eventLimit;
    public TenantQuotaPolicy(long byteLimit = 500 * 1024 * 1024, int attachmentLimit = 10_000, int eventLimit = 100_000) { this.byteLimit = byteLimit; this.attachmentLimit = attachmentLimit; this.eventLimit = eventLimit; }
    public PolicyResult Evaluate(QuotaSnapshot usage, AttachmentInput? attachment, bool eventCreated)
    {
        var issues = new List<ValidationIssue>();
        var bytes = usage.BytesUsed + (attachment?.Content.Length ?? 0);
        if (bytes > byteLimit) issues.Add(new("tenant.quota.bytes", "Tenant attachment byte quota is exhausted.", ValidationSeverity.Error));
        if (attachment is not null && usage.AttachmentsUsed + 1 > attachmentLimit) issues.Add(new("tenant.quota.attachments", "Tenant attachment quota is exhausted.", ValidationSeverity.Error));
        if (eventCreated && usage.EventsUsed + 1 > eventLimit) issues.Add(new("tenant.quota.events", "Tenant event quota is exhausted.", ValidationSeverity.Error));
        return issues.Count == 0 ? PolicyResult.Allow() : PolicyResult.Deny([.. issues]);
    }
    public bool IsWithin(QuotaSnapshot usage) => usage.BytesUsed <= byteLimit && usage.AttachmentsUsed <= attachmentLimit && usage.EventsUsed <= eventLimit;
}

public sealed class ActorPermissionPolicy
{
    private readonly IReadOnlyDictionary<string, string> requiredPermissions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["asset.submit"] = "asset.write", ["asset.read"] = "asset.read", ["order.submit"] = "order.write", ["audit.read"] = "audit.read", ["reconcile.run"] = "reconcile.run",
    };
    public PolicyResult Evaluate(TenantScope scope, string operation)
    {
        if (scope.IsExpired(DateTimeOffset.UtcNow)) return PolicyResult.Deny(new("permission.expired", "Actor scope has expired.", ValidationSeverity.Error));
        if (!requiredPermissions.TryGetValue(operation, out var permission)) return PolicyResult.Deny(new("permission.operation.unknown", "Operation is not registered.", ValidationSeverity.Error));
        return scope.Can(permission) || scope.Can(operation) ? PolicyResult.Allow() : PolicyResult.Deny(new("permission.denied", $"Permission '{permission}' is required.", ValidationSeverity.Error));
    }
}

public sealed class ResourceOwnershipPolicy
{
    public PolicyResult Evaluate(string tenantId, string resourceTenantId, string resourceId)
    {
        if (string.IsNullOrWhiteSpace(resourceId)) return PolicyResult.Deny(new("resource.id.empty", "Resource id is required.", ValidationSeverity.Error));
        return string.Equals(tenantId, resourceTenantId, StringComparison.Ordinal) ? PolicyResult.Allow() : PolicyResult.Deny(new("resource.tenant.mismatch", "Resource belongs to another tenant.", ValidationSeverity.Error));
    }
}

public sealed class EventAgePolicy
{
    private readonly TimeSpan maximumAge;
    public EventAgePolicy(TimeSpan? maximumAge = null) => this.maximumAge = maximumAge ?? TimeSpan.FromDays(7);
    public PolicyResult Evaluate(AssetEvent assetEvent, DateTimeOffset now)
    {
        if (assetEvent.CreatedAt > now.AddMinutes(1)) return PolicyResult.Deny(new("event.clock.future", "Event timestamp is too far in the future.", ValidationSeverity.Error));
        if (now - assetEvent.CreatedAt > maximumAge) return PolicyResult.Deny(new("event.age.expired", "Event is outside the accepted replay window.", ValidationSeverity.Error));
        return PolicyResult.Allow();
    }
}

public sealed class BatchSizePolicy
{
    public PolicyResult Evaluate<T>(IReadOnlyCollection<T> items, int maximum, string code)
    {
        if (maximum <= 0) return PolicyResult.Deny(new("batch.maximum.invalid", "Maximum batch size must be positive.", ValidationSeverity.Error));
        return items.Count <= maximum ? PolicyResult.Allow() : PolicyResult.Deny(new(code, "Batch exceeds the configured maximum.", ValidationSeverity.Error));
    }
}

public sealed class HeaderPolicy
{
    private readonly IReadOnlySet<string> allowed;
    public HeaderPolicy(IEnumerable<string>? allowed = null) => this.allowed = new HashSet<string>(allowed ?? ["actor", "schema", "trace", "source"], StringComparer.OrdinalIgnoreCase);
    public PolicyResult Evaluate(IReadOnlyDictionary<string, string> headers)
    {
        var issues = headers.Where(x => !allowed.Contains(x.Key) || string.IsNullOrWhiteSpace(x.Value)).Select(x => new ValidationIssue("event.header.invalid", $"Header '{x.Key}' is not valid.", ValidationSeverity.Error)).ToArray();
        return issues.Length == 0 ? PolicyResult.Allow() : PolicyResult.Deny(issues);
    }
}
