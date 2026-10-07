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
        var issues = new List<ValidationIssue>();
        foreach (var rule in rules)
        {
            var issue = rule.Validate(value);
            if (issue is not null)
            {
                issues.Add(issue);
            }
        }

        var allowed = !issues.Any(issue => issue.BlocksOperation);
        return new PolicyResult(allowed, issues);
    }

    public IReadOnlyList<string> RuleNames()
    {
        return rules.Select(rule => rule.GetType().Name).ToList();
    }
}

public sealed class RequiredAssetIdRule : IValidationRule<AssetEvent>
{
    public ValidationIssue? Validate(AssetEvent value)
    {
        if (value is null || string.IsNullOrWhiteSpace(value.AssetId))
        {
            return new ValidationIssue("asset.id.required", "Asset id is required.", ValidationSeverity.Error);
        }

        return null;
    }
}

public sealed class RequiredEventTypeRule : IValidationRule<AssetEvent>
{
    public ValidationIssue? Validate(AssetEvent value)
    {
        if (value is null || string.IsNullOrWhiteSpace(value.EventType))
        {
            return new ValidationIssue("asset.eventtype.required", "Event type is required.", ValidationSeverity.Error);
        }

        return null;
    }
}

public sealed class EventTenantRule : IValidationRule<AssetEvent>
{
    public ValidationIssue? Validate(AssetEvent value)
    {
        if (value is null || string.IsNullOrWhiteSpace(value.TenantId))
        {
            return new ValidationIssue("asset.tenant.required", "Tenant id is required.", ValidationSeverity.Error);
        }

        return null;
    }
}

public sealed class OrderCurrencyRule : IValidationRule<OrderRequest>
{
    private readonly IReadOnlySet<string>? supported;
    public OrderCurrencyRule(IEnumerable<string>? supported = null) => this.supported = supported is null ? null : new HashSet<string>(supported, StringComparer.OrdinalIgnoreCase);

    public ValidationIssue? Validate(OrderRequest value)
    {
        if (value is null || string.IsNullOrWhiteSpace(value.Currency))
        {
            return new ValidationIssue("order.currency.unsupported", "Currency is required and must be supported.", ValidationSeverity.Error);
        }

        if (supported is not null && !supported.Contains(value.Currency))
        {
            return new ValidationIssue("order.currency.unsupported", $"Currency '{value.Currency}' is not supported.", ValidationSeverity.Error);
        }

        return null;
    }
}

public sealed class OrderLineCountRule : IValidationRule<OrderRequest>
{
    private readonly int maximum;
    public OrderLineCountRule(int maximum = 0) => this.maximum = maximum;

    public ValidationIssue? Validate(OrderRequest value)
    {
        if (value is null || value.Lines is null || value.Lines.Count == 0)
        {
            return new ValidationIssue("order.lines.empty", "Order must contain at least one line.", ValidationSeverity.Error);
        }

        if (maximum > 0 && value.Lines.Count > maximum)
        {
            return new ValidationIssue("order.lines.exceeded", $"Order line count {value.Lines.Count} exceeds the maximum of {maximum}.", ValidationSeverity.Error);
        }

        return null;
    }
}

public sealed class AttachmentTenantRule : IValidationRule<AttachmentInput>
{
    private readonly string? expectedTenant;
    public AttachmentTenantRule(string? expectedTenant = null) => this.expectedTenant = expectedTenant;

    public ValidationIssue? Validate(AttachmentInput value)
    {
        if (value is null || string.IsNullOrWhiteSpace(value.TenantId))
        {
            return new ValidationIssue("attachment.tenant.invalid", "Attachment tenant is required.", ValidationSeverity.Error);
        }

        if (expectedTenant is not null && !string.Equals(value.TenantId, expectedTenant, StringComparison.Ordinal))
        {
            return new ValidationIssue("attachment.tenant.invalid", "Attachment tenant does not match the request tenant.", ValidationSeverity.Error);
        }

        return null;
    }
}

public sealed class AttachmentScanRule : IValidationRule<AttachmentInput>
{
    public ValidationIssue? Validate(AttachmentInput value)
    {
        if (value is null || !value.Scanned)
        {
            return new ValidationIssue("attachment.scan.pending", "Attachment has not passed scanning.", ValidationSeverity.Warning);
        }

        return null;
    }
}

public sealed class ValidationIssueCatalog
{
    private static readonly IReadOnlyDictionary<string, string> Defaults = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["asset.id.required"] = "Asset id is required.",
        ["asset.eventtype.required"] = "Event type is required.",
        ["asset.tenant.required"] = "Tenant id is required.",
        ["order.currency.unsupported"] = "Currency is required and must be supported.",
        ["order.lines.exceeded"] = "Order line count exceeds the maximum.",
        ["order.lines.empty"] = "Order must contain at least one line.",
        ["attachment.tenant.invalid"] = "Attachment tenant is invalid.",
        ["attachment.scan.pending"] = "Attachment has not passed scanning.",
    };

    private readonly IReadOnlyDictionary<string, string> descriptions = Defaults;

    public string Describe(string code)
    {
        if (code is not null && descriptions.TryGetValue(code, out var message))
        {
            return message;
        }

        return code ?? string.Empty;
    }

    public bool Contains(string code) => code is not null && descriptions.ContainsKey(code);

    public IReadOnlyCollection<string> Codes => descriptions.Keys.ToList();
}
