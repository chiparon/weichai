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
        ArgumentNullException.ThrowIfNull(command);
        cancellationToken.ThrowIfCancellationRequested();

        var order = new RequestNormalizer().Normalize(command.Request);

        if (!validator.IsValid(order, out var reason))
        {
            var invalid = new ValidationIssue("order.invalid", reason ?? "Order failed validation.", ValidationSeverity.Error);
            return await Reject(order, invalid).ConfigureAwait(false);
        }

        if (idempotency.HasCompleted(order.TenantId, order.OrderId)
            || await repository.ExistsAsync(order.TenantId, order.OrderId, cancellationToken).ConfigureAwait(false))
        {
            return Duplicate(order.OrderId);
        }

        return await transaction.ExecuteAsync(async token =>
        {
            var now = clock.UtcNow;
            var price = pricing.Calculate(order);
            var requirement = payment.Determine(price, null);
            var snapshot = new OrderSnapshot(order, OrderLifecycleState.Draft, price, requirement, null, null, now, 0);
            var aggregate = new OrderAggregate(snapshot);
            aggregate.Validate(now);

            var reservation = await inventory.ReserveAsync(order, token).ConfigureAwait(false);
            var domainReservation = ToReservation(order, reservation, now);
            var policy = inventoryPolicy.Evaluate(order, domainReservation);

            if (!reservation.Reserved || !policy.Allowed)
            {
                var reason = reservation.Detail ?? policy.Issues.FirstOrDefault()?.Message ?? "Inventory reservation failed.";
                aggregate.Rollback(clock.UtcNow, reason);
                await repository.SaveAsync(aggregate.Snapshot, token).ConfigureAwait(false);
                audit.Record(new AuditRecord(order.TenantId, order.OrderId, "order.rolledback", OrderLifecycleState.RolledBack.ToString().ToLowerInvariant(), clock.UtcNow));
                var issue = policy.Issues.FirstOrDefault()
                    ?? new ValidationIssue("order.inventory", reason, ValidationSeverity.Error);
                return new OrderSubmissionResult(false, aggregate.Snapshot.State, price, null, new[] { issue }, aggregate.SideEffects);
            }

            aggregate.Reserve(domainReservation!, clock.UtcNow);
            await committer.CommitAsync(order, reservation, token).ConfigureAwait(false);
            aggregate.Commit(clock.UtcNow);
            await repository.SaveAsync(aggregate.Snapshot, token).ConfigureAwait(false);
            idempotency.MarkCompleted(order.TenantId, order.OrderId);
            audit.Record(new AuditRecord(order.TenantId, order.OrderId, "order.accepted", OrderLifecycleState.Accepted.ToString().ToLowerInvariant(), clock.UtcNow));
            return new OrderSubmissionResult(true, OrderLifecycleState.Accepted, price, domainReservation!.ReservationId, Array.Empty<ValidationIssue>(), aggregate.SideEffects);
        }, cancellationToken).ConfigureAwait(false);
    }

    private static OrderSubmissionResult Duplicate(string orderId)
        => new(true, OrderLifecycleState.Accepted, null, null, Array.Empty<ValidationIssue>(), Array.Empty<string>());

    private Task<OrderSubmissionResult> Reject(OrderRequest order, ValidationIssue issue)
    {
        audit.Record(new AuditRecord(order.TenantId, order.OrderId, "order.rejected", OrderLifecycleState.Rejected.ToString().ToLowerInvariant(), clock.UtcNow));
        return Task.FromResult(new OrderSubmissionResult(false, OrderLifecycleState.Rejected, null, null, new[] { issue }, Array.Empty<string>()));
    }

    private static InventoryReservation? ToReservation(OrderRequest order, ReservationResult reservation, DateTimeOffset now)
    {
        if (!reservation.Reserved || string.IsNullOrEmpty(reservation.ReservationId))
        {
            return null;
        }

        var quantities = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var line in order.Lines)
        {
            quantities[line.Sku] = quantities.TryGetValue(line.Sku, out var existing) ? existing + line.Quantity : line.Quantity;
        }

        return new InventoryReservation(reservation.ReservationId, order.TenantId, order.OrderId, quantities, now.AddMinutes(15), false);
    }
}

public sealed class OrderPluginValidationService
{
    private readonly IPluginRegistry registry;
    private readonly PluginCapabilityPolicy policy;
    public OrderPluginValidationService(IPluginRegistry registry, PluginCapabilityPolicy? policy = null) { this.registry = registry; this.policy = policy ?? new(); }

    public async Task<PolicyResult> EvaluateAsync(OrderCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        var plugin = await registry.FindCapabilityAsync(command.TenantId, command.Operation, cancellationToken).ConfigureAwait(false);
        if (plugin is null)
        {
            return PolicyResult.Deny(new ValidationIssue("plugin.missing", $"No plugin is registered for operation '{command.Operation}'.", ValidationSeverity.Error));
        }

        var invocation = new PluginInvocation(
            plugin.PluginId,
            command.TenantId,
            command.Operation,
            command.CommandId,
            new Dictionary<string, string>(StringComparer.Ordinal),
            DateTimeOffset.UtcNow);
        return policy.Evaluate(plugin, invocation);
    }
}

public sealed class OrderReadService
{
    private readonly IOrderAggregateRepository repository;
    public OrderReadService(IOrderAggregateRepository repository) => this.repository = repository;

    public Task<OrderSnapshot?> FindAsync(string tenantId, string orderId, CancellationToken cancellationToken = default)
        => repository.FindAsync(tenantId, orderId, cancellationToken);

    public async Task<OrderSnapshot> RequireAsync(string tenantId, string orderId, CancellationToken cancellationToken = default)
    {
        var snapshot = await repository.FindAsync(tenantId, orderId, cancellationToken).ConfigureAwait(false);
        if (snapshot is null)
        {
            throw new KeyNotFoundException($"Order '{orderId}' was not found for tenant '{tenantId}'.");
        }

        return snapshot;
    }
}
