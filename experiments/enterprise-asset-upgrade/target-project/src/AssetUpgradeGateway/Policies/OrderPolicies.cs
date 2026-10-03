namespace AssetUpgradeGateway.Policies;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;

public sealed record OrderPolicyOptions(long MaximumOrderTotalMinor, int MaximumLineCount, int MaximumQuantity, IReadOnlySet<string> SupportedCurrencies);

public sealed class OrderValidationPolicy : IOrderValidator
{
    private readonly OrderPolicyOptions options;
    public OrderValidationPolicy(OrderPolicyOptions? options = null) => this.options = options ?? new(10_000_000, 100, 10_000, new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "CNY", "USD", "EUR" });

    public bool IsValid(OrderRequest order, out string? reason)
    {
        var result = Evaluate(order);
        reason = result.Issues.FirstOrDefault(x => x.BlocksOperation)?.Message;
        return result.Allowed;
    }

    public PolicyResult Evaluate(OrderRequest order)
    {
        var issues = new List<ValidationIssue>();
        if (string.IsNullOrWhiteSpace(order.OrderId)) issues.Add(new("order.id.empty", "Order id is required.", ValidationSeverity.Error));
        if (string.IsNullOrWhiteSpace(order.TenantId)) issues.Add(new("order.tenant.empty", "Tenant id is required.", ValidationSeverity.Error));
        if (string.IsNullOrWhiteSpace(order.ActorId)) issues.Add(new("order.actor.empty", "Actor id is required.", ValidationSeverity.Error));
        if (!options.SupportedCurrencies.Contains(order.Currency)) issues.Add(new("order.currency.unsupported", "Currency is not enabled for this tenant.", ValidationSeverity.Error));
        if (order.Lines.Count == 0) issues.Add(new("order.lines.empty", "At least one order line is required.", ValidationSeverity.Error));
        if (order.Lines.Count > options.MaximumLineCount) issues.Add(new("order.lines.limit", "Order has too many lines.", ValidationSeverity.Error));
        for (var index = 0; index < order.Lines.Count; index++)
        {
            var line = order.Lines[index];
            if (string.IsNullOrWhiteSpace(line.Sku)) issues.Add(new($"order.line.{index}.sku", "SKU is required.", ValidationSeverity.Error));
            if (line.Quantity is <= 0 or > 10_000) issues.Add(new($"order.line.{index}.quantity", "Quantity is outside the allowed range.", ValidationSeverity.Error));
            if (line.UnitPriceMinor < 0) issues.Add(new($"order.line.{index}.price", "Unit price cannot be negative.", ValidationSeverity.Error));
        }
        if (order.Lines.GroupBy(x => x.Sku, StringComparer.OrdinalIgnoreCase).Any(g => g.Count() > 1)) issues.Add(new("order.lines.duplicate", "Duplicate SKUs must be merged before submission.", ValidationSeverity.Error));
        var total = order.Lines.Sum(x => checked((long)x.Quantity * x.UnitPriceMinor));
        if (total > options.MaximumOrderTotalMinor) issues.Add(new("order.total.limit", "Order total exceeds the configured limit.", ValidationSeverity.Error));
        return issues.Any(x => x.BlocksOperation) ? PolicyResult.Deny([.. issues]) : new(true, issues);
    }
}

public sealed class PriceCalculationPolicy
{
    public PriceBreakdown Calculate(OrderRequest order, CustomerAccount? customer = null)
    {
        var merchandise = order.Lines.Sum(x => checked((long)x.Quantity * x.UnitPriceMinor));
        var discount = customer?.IsSegment("employee") == true ? merchandise / 10 : customer?.IsSegment("partner") == true ? merchandise / 20 : 0;
        var shipping = merchandise >= 10_000 ? 0 : 1_200;
        var taxable = merchandise - discount + shipping;
        var tax = order.Currency.Equals("CNY", StringComparison.OrdinalIgnoreCase) ? taxable / 10 : taxable / 20;
        return new(merchandise, discount, shipping, tax, order.Currency);
    }
}

public sealed class PaymentRequirementPolicy
{
    public PaymentRequirement Determine(PriceBreakdown price, CustomerAccount? customer)
    {
        if (price.GrandTotalMinor <= 0) return PaymentRequirement.None;
        if (customer?.IsSegment("trusted") == true && price.GrandTotalMinor < 100_000) return PaymentRequirement.CaptureOnCommit;
        return PaymentRequirement.PreAuthorization;
    }
}

public sealed class InventoryPolicy
{
    public PolicyResult Evaluate(OrderRequest order, InventoryReservation? reservation)
    {
        var issues = new List<ValidationIssue>();
        if (reservation is null) issues.Add(new("inventory.reservation.missing", "A reservation is required before commit.", ValidationSeverity.Error));
        else
        {
            if (!reservation.ContainsAll(order.Lines)) issues.Add(new("inventory.reservation.incomplete", "Reservation does not cover every order line.", ValidationSeverity.Error));
            if (reservation.IsExpired(DateTimeOffset.UtcNow)) issues.Add(new("inventory.reservation.expired", "Inventory reservation has expired.", ValidationSeverity.Error));
            if (reservation.Released) issues.Add(new("inventory.reservation.released", "Inventory reservation was released.", ValidationSeverity.Error));
        }
        return issues.Count == 0 ? PolicyResult.Allow() : PolicyResult.Deny([.. issues]);
    }
}

public sealed class OrderStateMachine
{
    private static readonly IReadOnlyDictionary<OrderLifecycleState, IReadOnlySet<OrderLifecycleState>> Allowed = new Dictionary<OrderLifecycleState, IReadOnlySet<OrderLifecycleState>>
    {
        [OrderLifecycleState.Draft] = new HashSet<OrderLifecycleState> { OrderLifecycleState.Validating, OrderLifecycleState.Rejected },
        [OrderLifecycleState.Validating] = new HashSet<OrderLifecycleState> { OrderLifecycleState.AwaitingInventory, OrderLifecycleState.Rejected },
        [OrderLifecycleState.AwaitingInventory] = new HashSet<OrderLifecycleState> { OrderLifecycleState.Reserved, OrderLifecycleState.Rejected },
        [OrderLifecycleState.Reserved] = new HashSet<OrderLifecycleState> { OrderLifecycleState.Committing, OrderLifecycleState.RollingBack },
        [OrderLifecycleState.Committing] = new HashSet<OrderLifecycleState> { OrderLifecycleState.Accepted, OrderLifecycleState.RollingBack },
        [OrderLifecycleState.Accepted] = new HashSet<OrderLifecycleState>(),
        [OrderLifecycleState.Rejected] = new HashSet<OrderLifecycleState>(),
        [OrderLifecycleState.RollingBack] = new HashSet<OrderLifecycleState> { OrderLifecycleState.RolledBack },
        [OrderLifecycleState.RolledBack] = new HashSet<OrderLifecycleState>(),
    };
    public bool CanTransition(OrderLifecycleState from, OrderLifecycleState to) => Allowed[from].Contains(to);
    public OrderLifecycleState Transition(OrderLifecycleState from, OrderLifecycleState to) => CanTransition(from, to) ? to : throw new InvalidOperationException($"Order transition {from} -> {to} is invalid.");
}

public sealed class PluginCapabilityPolicy
{
    public PolicyResult Evaluate(PluginDescriptor plugin, PluginInvocation invocation)
    {
        var issues = new List<ValidationIssue>();
        if (!plugin.Enabled) issues.Add(new("plugin.disabled", "The selected plugin is disabled.", ValidationSeverity.Error));
        if (!string.Equals(plugin.TenantId, invocation.TenantId, StringComparison.Ordinal)) issues.Add(new("plugin.tenant", "Plugin belongs to another tenant.", ValidationSeverity.Error));
        if (!plugin.Supports(invocation.Operation)) issues.Add(new("plugin.capability", $"Plugin does not support '{invocation.Operation}'.", ValidationSeverity.Error));
        if (string.IsNullOrWhiteSpace(invocation.RequestId)) issues.Add(new("plugin.request.empty", "Plugin request id is required.", ValidationSeverity.Error));
        return issues.Count == 0 ? PolicyResult.Allow() : PolicyResult.Deny([.. issues]);
    }
}

public sealed class OrderIdempotencyPolicy
{
    public PolicyResult Evaluate(bool alreadyCompleted, string operationId)
        => alreadyCompleted
            ? PolicyResult.Deny(new("order.duplicate", $"Operation '{operationId}' has already completed.", ValidationSeverity.Warning))
            : PolicyResult.Allow();
}
