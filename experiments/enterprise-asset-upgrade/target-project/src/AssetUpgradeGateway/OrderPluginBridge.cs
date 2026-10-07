namespace AssetUpgradeGateway;

public sealed class OrderPluginBridge
{
    private const string RejectedAction = "order.rejected";
    private const string RolledBackAction = "order.rolledback";
    private const string AcceptedAction = "order.accepted";

    private readonly IOrderValidator validator;
    private readonly IInventoryGateway inventory;
    private readonly IIdempotencyStore idempotency;
    private readonly IOrderCommitter committer;
    private readonly IAuditSink audit;

    public OrderPluginBridge(
        IOrderValidator validator,
        IInventoryGateway inventory,
        IIdempotencyStore idempotency,
        IOrderCommitter committer,
        IAuditSink audit)
    {
        this.validator = validator;
        this.inventory = inventory;
        this.idempotency = idempotency;
        this.committer = committer;
        this.audit = audit;
    }

    public async Task<OrderResult> SubmitAsync(
        OrderRequest order,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(order);
        cancellationToken.ThrowIfCancellationRequested();

        if (!validator.IsValid(order, out var reason))
        {
            audit.Record(new AuditRecord(order.TenantId, order.OrderId, RejectedAction, OrderStatus.Rejected.ToString().ToLowerInvariant(), DateTimeOffset.UtcNow));
            return new OrderResult(false, OrderStatus.Rejected, null, reason ?? "Order failed validation.");
        }

        if (idempotency.HasCompleted(order.TenantId, order.OrderId))
        {
            return new OrderResult(true, OrderStatus.Accepted, null, "Duplicate request ignored.");
        }

        try
        {
            var reservation = await inventory.ReserveAsync(order, cancellationToken).ConfigureAwait(false);
            if (!reservation.Reserved)
            {
                audit.Record(new AuditRecord(order.TenantId, order.OrderId, RolledBackAction, OrderStatus.RolledBack.ToString().ToLowerInvariant(), DateTimeOffset.UtcNow));
                return new OrderResult(false, OrderStatus.RolledBack, null, reservation.Detail ?? "Inventory reservation failed.");
            }

            await committer.CommitAsync(order, reservation, cancellationToken).ConfigureAwait(false);
            idempotency.MarkCompleted(order.TenantId, order.OrderId);
            audit.Record(new AuditRecord(order.TenantId, order.OrderId, AcceptedAction, OrderStatus.Accepted.ToString().ToLowerInvariant(), DateTimeOffset.UtcNow));
            return new OrderResult(true, OrderStatus.Accepted, reservation.ReservationId, null);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            audit.Record(new AuditRecord(order.TenantId, order.OrderId, RolledBackAction, OrderStatus.RolledBack.ToString().ToLowerInvariant(), DateTimeOffset.UtcNow));
            return new OrderResult(false, OrderStatus.RolledBack, null, ex.Message);
        }
    }
}
