namespace AssetUpgradeGateway.Domain;

using AssetUpgradeGateway;

public enum OrderLifecycleState
{
    Draft,
    Validating,
    AwaitingInventory,
    Reserved,
    Committing,
    Accepted,
    Rejected,
    RollingBack,
    RolledBack,
}

public enum PaymentRequirement
{
    None,
    PreAuthorization,
    CaptureOnCommit,
}

public sealed record CustomerAccount(
    string CustomerId,
    string TenantId,
    string? Email,
    string Currency,
    IReadOnlySet<string> Segments)
{
    public bool BelongsTo(string tenantId) => string.Equals(TenantId, tenantId, StringComparison.Ordinal);

    public bool IsSegment(string segment) => Segments.Contains(segment);
}

public sealed record PriceBreakdown(
    long MerchandiseMinor,
    long DiscountMinor,
    long ShippingMinor,
    long TaxMinor,
    string Currency)
{
    public long GrandTotalMinor => checked(MerchandiseMinor - DiscountMinor + ShippingMinor + TaxMinor);

    public PriceBreakdown ApplyDiscount(long discountMinor)
    {
        if (discountMinor < 0 || discountMinor > MerchandiseMinor) throw new ArgumentOutOfRangeException(nameof(discountMinor));
        return this with { DiscountMinor = discountMinor };
    }
}

public sealed record InventoryReservation(
    string ReservationId,
    string TenantId,
    string OrderId,
    IReadOnlyDictionary<string, int> Quantities,
    DateTimeOffset ExpiresAt,
    bool Released)
{
    public bool IsExpired(DateTimeOffset now) => now >= ExpiresAt;

    public InventoryReservation Release() => this with { Released = true };

    public bool Contains(string sku, int quantity)
        => Quantities.TryGetValue(sku, out var reserved) && reserved >= quantity;
}

public sealed record OrderSnapshot(
    OrderRequest Request,
    OrderLifecycleState State,
    PriceBreakdown Price,
    PaymentRequirement PaymentRequirement,
    InventoryReservation? Reservation,
    string? RejectionReason,
    DateTimeOffset UpdatedAt,
    int Version)
{
    public bool IsTerminal => State is OrderLifecycleState.Accepted or OrderLifecycleState.Rejected or OrderLifecycleState.RolledBack;

    public OrderSnapshot BeginValidation(DateTimeOffset now) => Transition(OrderLifecycleState.Validating, now);

    public OrderSnapshot AwaitInventory(DateTimeOffset now) => Transition(OrderLifecycleState.AwaitingInventory, now);

    public OrderSnapshot Reserve(InventoryReservation reservation, DateTimeOffset now)
        => Transition(OrderLifecycleState.Reserved, now) with { Reservation = reservation };

    public OrderSnapshot BeginCommit(DateTimeOffset now) => Transition(OrderLifecycleState.Committing, now);

    public OrderSnapshot Accept(DateTimeOffset now) => Transition(OrderLifecycleState.Accepted, now);

    public OrderSnapshot Reject(string reason, DateTimeOffset now)
        => Transition(OrderLifecycleState.Rejected, now) with { RejectionReason = reason };

    public OrderSnapshot BeginRollback(DateTimeOffset now) => Transition(OrderLifecycleState.RollingBack, now);

    public OrderSnapshot CompleteRollback(DateTimeOffset now) => Transition(OrderLifecycleState.RolledBack, now);

    private OrderSnapshot Transition(OrderLifecycleState next, DateTimeOffset now)
    {
        if (IsTerminal && next != OrderLifecycleState.RolledBack)
            throw new InvalidOperationException($"Order {Request.OrderId} is already terminal.");
        return this with { State = next, UpdatedAt = now, Version = Version + 1 };
    }
}

public sealed record PluginDescriptor(
    string PluginId,
    string TenantId,
    string DisplayName,
    Version Version,
    IReadOnlySet<string> Capabilities,
    bool Enabled)
{
    public bool Supports(string capability) => Enabled && Capabilities.Contains(capability);

    public PluginDescriptor Disable() => this with { Enabled = false };

    public PluginDescriptor Enable() => this with { Enabled = true };
}

public sealed record PluginInvocation(
    string PluginId,
    string TenantId,
    string Operation,
    string RequestId,
    IReadOnlyDictionary<string, string> Parameters,
    DateTimeOffset RequestedAt)
{
    public PluginInvocation WithParameter(string key, string value)
    {
        var parameters = new Dictionary<string, string>(Parameters, StringComparer.OrdinalIgnoreCase) { [key] = value };
        return this with { Parameters = parameters };
    }
}

public sealed record OrderDecision(
    bool Allowed,
    IReadOnlyList<ValidationIssue> Issues,
    PriceBreakdown? Price,
    PaymentRequirement PaymentRequirement,
    string DecisionCode)
{
    public bool HasBlockingIssue => Issues.Any(item => item.BlocksOperation);

    public static OrderDecision Deny(string code, params ValidationIssue[] issues)
        => new(false, issues, null, PaymentRequirement.None, code);

    public static OrderDecision Allow(PriceBreakdown price, PaymentRequirement payment)
        => new(true, [], price, payment, "accepted");
}

public sealed record OrderOperationResult(
    string OperationId,
    bool Succeeded,
    OrderLifecycleState State,
    IReadOnlyList<string> SideEffects,
    IReadOnlyList<ValidationIssue> Issues)
{
    public static OrderOperationResult Rejected(string operationId, params ValidationIssue[] issues)
        => new(operationId, false, OrderLifecycleState.Rejected, [], issues);
}

public sealed class OrderAggregate
{
    private readonly List<string> sideEffects = [];

    public OrderAggregate(OrderSnapshot snapshot)
    {
        Snapshot = snapshot ?? throw new ArgumentNullException(nameof(snapshot));
    }

    public OrderSnapshot Snapshot { get; internal set; }

    public IReadOnlyList<string> SideEffects => sideEffects;

    public void Validate(DateTimeOffset now) => Snapshot = Snapshot.BeginValidation(now);

    public void Reserve(InventoryReservation reservation, DateTimeOffset now)
    {
        Snapshot = Snapshot.Reserve(reservation, now);
        sideEffects.Add($"inventory:reserved:{reservation.ReservationId}");
    }

    public void Commit(DateTimeOffset now)
    {
        Snapshot = Snapshot.BeginCommit(now).Accept(now);
        sideEffects.Add($"order:accepted:{Snapshot.Request.OrderId}");
    }

    public void Rollback(DateTimeOffset now, string reason)
    {
        Snapshot = Snapshot.BeginRollback(now).CompleteRollback(now) with { RejectionReason = reason };
        sideEffects.Add($"order:rolled-back:{Snapshot.Request.OrderId}");
    }
}

public sealed record OrderBatch(
    string TenantId,
    IReadOnlyList<OrderRequest> Orders,
    string BatchId,
    DateTimeOffset CreatedAt)
{
    public int Count => Orders.Count;

    public bool ContainsTenantOnly()
        => Orders.All(order => string.Equals(order.TenantId, TenantId, StringComparison.Ordinal));
}
