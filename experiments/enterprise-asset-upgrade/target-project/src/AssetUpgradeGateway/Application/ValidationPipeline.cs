namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;

public interface IValidationRule<in T>
{
    ValidationIssue? Validate(T value);
}

public sealed class ValidationPipeline<T>
{
    private readonly IReadOnlyList<IValidationRule<T>> rules;
    public ValidationPipeline(IEnumerable<IValidationRule<T>> rules) => this.rules = rules.ToArray();
    public PolicyResult Evaluate(T value)
    {
        var issues = rules.Select(rule => rule.Validate(value)).Where(issue => issue is not null).Cast<ValidationIssue>().ToArray();
        return issues.Any(x => x.BlocksOperation) ? PolicyResult.Deny(issues) : new(true, issues);
    }
    public IReadOnlyList<string> RuleNames() => rules.Select(x => x.GetType().Name).ToArray();
}

public sealed class RequiredAssetIdRule : IValidationRule<AssetEvent>
{
    public ValidationIssue? Validate(AssetEvent value) => string.IsNullOrWhiteSpace(value.AssetId) ? new("event.asset.empty", "Asset id is required.", ValidationSeverity.Error) : null;
}

public sealed class RequiredEventTypeRule : IValidationRule<AssetEvent>
{
    public ValidationIssue? Validate(AssetEvent value) => string.IsNullOrWhiteSpace(value.EventType) ? new("event.type.empty", "Event type is required.", ValidationSeverity.Error) : null;
}

public sealed class EventTenantRule : IValidationRule<AssetEvent>
{
    public ValidationIssue? Validate(AssetEvent value) => string.IsNullOrWhiteSpace(value.TenantId) ? new("event.tenant.empty", "Tenant id is required.", ValidationSeverity.Error) : null;
}

public sealed class OrderCurrencyRule : IValidationRule<OrderRequest>
{
    private readonly IReadOnlySet<string> supported;
    public OrderCurrencyRule(IEnumerable<string>? supported = null) => this.supported = new HashSet<string>(supported ?? ["CNY", "USD", "EUR"], StringComparer.OrdinalIgnoreCase);
    public ValidationIssue? Validate(OrderRequest value) => supported.Contains(value.Currency) ? null : new("order.currency.unsupported", "Currency is not supported.", ValidationSeverity.Error);
}

public sealed class OrderLineCountRule : IValidationRule<OrderRequest>
{
    private readonly int maximum;
    public OrderLineCountRule(int maximum = 100) => this.maximum = maximum;
    public ValidationIssue? Validate(OrderRequest value) => value.Lines.Count <= maximum ? null : new("order.lines.limit", "Order has too many lines.", ValidationSeverity.Error);
}

public sealed class AttachmentTenantRule : IValidationRule<AttachmentInput>
{
    public ValidationIssue? Validate(AttachmentInput value) => string.IsNullOrWhiteSpace(value.TenantId) ? new("attachment.tenant.empty", "Attachment tenant is required.", ValidationSeverity.Error) : null;
}

public sealed class AttachmentScanRule : IValidationRule<AttachmentInput>
{
    public ValidationIssue? Validate(AttachmentInput value) => value.Scanned ? null : new("attachment.scan.required", "Attachment scan is required.", ValidationSeverity.Error);
}

public sealed class ValidationIssueCatalog
{
    private readonly IReadOnlyDictionary<string, string> descriptions = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["tenant.access.denied"] = "Actor is outside the tenant boundary.", ["attachment.filename.characters"] = "Attachment name contains unsafe path characters.", ["attachment.signature.mismatch"] = "Attachment bytes do not match the declared file type.", ["event.retry.exhausted"] = "The event exhausted its retry budget.", ["order.duplicate"] = "The order operation was already completed.", ["inventory.unavailable"] = "Inventory could not cover the requested quantity.", ["plugin.missing"] = "No enabled plugin supports the requested capability.", ["reconciliation.lease.busy"] = "A reconciliation run is already active.",
    };
    public string Describe(string code) => descriptions.TryGetValue(code, out var value) ? value : "No description has been registered for this validation code.";
    public bool Contains(string code) => descriptions.ContainsKey(code);
    public IReadOnlyCollection<string> Codes => descriptions.Keys;
}
