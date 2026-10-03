namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;

public sealed record OrderSubmissionCommand(OrderRequest Request, string CorrelationId);
public sealed record OrderSubmissionResult(bool Accepted, OrderLifecycleState State, PriceBreakdown? Price, string? ReservationId, IReadOnlyList<ValidationIssue> Issues, IReadOnlyList<string> SideEffects);

public sealed class OrderLifecycleService
{
    private readonly IOrderValidator validator;
    private readonly IInventoryGateway inventory;
    private readonly IOrderCommitter committer;
    private readonly IOrderAggregateRepository repository;
    private readonly IIdempotencyStore idempotency;
    private readonly IAuditSink audit;
    private readonly ITransactionBoundary transaction;
    private readonly IClock clock;
    private readonly PriceCalculationPolicy pricing;
    private readonly PaymentRequirementPolicy payment;
    private readonly InventoryPolicy inventoryPolicy = new();

    public OrderLifecycleService(IOrderValidator validator, IInventoryGateway inventory, IOrderCommitter committer, IOrderAggregateRepository repository, IIdempotencyStore idempotency, IAuditSink audit, ITransactionBoundary transaction, IClock? clock = null, PriceCalculationPolicy? pricing = null, PaymentRequirementPolicy? payment = null)
    {
        this.validator = validator; this.inventory = inventory; this.committer = committer; this.repository = repository; this.idempotency = idempotency; this.audit = audit; this.transaction = transaction; this.clock = clock ?? new Adapters.SystemClock(); this.pricing = pricing ?? new(); this.payment = payment ?? new();
    }

    public async Task<OrderSubmissionResult> SubmitAsync(OrderSubmissionCommand command, CancellationToken cancellationToken = default)
    {
        var order = command.Request;
        if (idempotency.HasCompleted(order.TenantId, order.OrderId)) return Duplicate(order.OrderId);
        if (!validator.IsValid(order, out var reason)) return Reject(order, new("order.validation", reason ?? "Order is invalid.", ValidationSeverity.Error));
        var price = pricing.Calculate(order);
        var requirement = payment.Determine(price, null);
        var initial = new OrderSnapshot(order, OrderLifecycleState.Draft, price, requirement, null, null, clock.UtcNow, 0);
        var aggregate = new OrderAggregate(initial);
        aggregate.Validate(clock.UtcNow);
        var reservation = await inventory.ReserveAsync(order, cancellationToken);
        if (!reservation.Reserved || reservation.ReservationId is null)
        {
            aggregate.Snapshot = aggregate.Snapshot.Reject(reservation.Detail ?? "Inventory reservation failed.", clock.UtcNow);
            await repository.SaveAsync(aggregate.Snapshot, cancellationToken);
            return new(false, aggregate.Snapshot.State, price, null, [new("inventory.unavailable", reservation.Detail ?? "Inventory reservation failed.", ValidationSeverity.Error)], aggregate.SideEffects);
        }
        var ledger = new InventoryReservation(reservation.ReservationId, order.TenantId, order.OrderId, order.Lines.ToDictionary(x => x.Sku, x => x.Quantity), clock.UtcNow.AddMinutes(15), false);
        aggregate.Reserve(ledger, clock.UtcNow);
        var check = inventoryPolicy.Evaluate(order, ledger);
        if (!check.Allowed) return new(false, aggregate.Snapshot.State, price, reservation.ReservationId, check.Issues, aggregate.SideEffects);
        try
        {
            await transaction.ExecuteAsync(async token =>
            {
                aggregate.Commit(clock.UtcNow);
                await committer.CommitAsync(order, reservation, token);
                await repository.SaveAsync(aggregate.Snapshot, token);
                return true;
            }, cancellationToken);
            idempotency.MarkCompleted(order.TenantId, order.OrderId);
            audit.Record(new(order.TenantId, order.OrderId, "order.commit", "accepted", clock.UtcNow));
            return new(true, aggregate.Snapshot.State, price, reservation.ReservationId, [], aggregate.SideEffects);
        }
        catch (Exception exception) when (exception is InvalidOperationException or TimeoutException)
        {
            aggregate.Rollback(clock.UtcNow, exception.Message);
            await repository.SaveAsync(aggregate.Snapshot, cancellationToken);
            audit.Record(new(order.TenantId, order.OrderId, "order.rollback", "failed", clock.UtcNow));
            return new(false, aggregate.Snapshot.State, price, reservation.ReservationId, [new("order.commit.failed", exception.Message, ValidationSeverity.Error)], aggregate.SideEffects);
        }
    }

    private static OrderSubmissionResult Duplicate(string orderId) => new(true, OrderLifecycleState.Accepted, null, null, [new("order.duplicate", $"Order {orderId} was already committed.", ValidationSeverity.Info)], []);
    private async Task<OrderSubmissionResult> Reject(OrderRequest order, ValidationIssue issue)
    {
        var price = order.Lines.Count == 0 ? null : pricing.Calculate(order);
        var snapshot = new OrderSnapshot(order, OrderLifecycleState.Rejected, price ?? new(0, 0, 0, 0, order.Currency), PaymentRequirement.None, null, issue.Message, clock.UtcNow, 1);
        await repository.SaveAsync(snapshot, CancellationToken.None);
        audit.Record(new(order.TenantId, order.OrderId, "order.reject", "rejected", clock.UtcNow));
        return new(false, snapshot.State, price, null, [issue], []);
    }
}

public sealed class OrderPluginValidationService
{
    private readonly IPluginRegistry registry;
    private readonly PluginCapabilityPolicy policy;
    public OrderPluginValidationService(IPluginRegistry registry, PluginCapabilityPolicy? policy = null) { this.registry = registry; this.policy = policy ?? new(); }
    public async Task<PolicyResult> EvaluateAsync(OrderCommand command, CancellationToken cancellationToken = default)
    {
        var plugin = await registry.FindCapabilityAsync(command.TenantId, command.Operation, cancellationToken);
        return plugin is null ? PolicyResult.Deny(new("plugin.missing", "No plugin provides the requested operation.", ValidationSeverity.Error)) : policy.Evaluate(plugin, new(plugin.PluginId, command.TenantId, command.Operation, command.CommandId, new Dictionary<string, string>(), DateTimeOffset.UtcNow));
    }
}

public sealed class OrderReadService
{
    private readonly IOrderAggregateRepository repository;
    public OrderReadService(IOrderAggregateRepository repository) => this.repository = repository;
    public Task<OrderSnapshot?> FindAsync(string tenantId, string orderId, CancellationToken cancellationToken = default) => repository.FindAsync(tenantId, orderId, cancellationToken);
    public async Task<OrderSnapshot> RequireAsync(string tenantId, string orderId, CancellationToken cancellationToken = default) => await FindAsync(tenantId, orderId, cancellationToken) ?? throw new KeyNotFoundException($"Order {orderId} was not found.");
}
