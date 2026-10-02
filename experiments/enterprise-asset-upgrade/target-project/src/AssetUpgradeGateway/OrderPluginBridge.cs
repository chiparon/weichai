namespace AssetUpgradeGateway;

public sealed class OrderPluginBridge(
    IOrderValidator validator,
    IInventoryGateway inventory,
    IIdempotencyStore idempotency,
    IOrderCommitter committer,
    IAuditSink audit)
{
    public Task<OrderResult> SubmitAsync(
        OrderRequest order,
        CancellationToken cancellationToken = default)
    {
        return Task.FromException<OrderResult>(
            new NotImplementedException("The benchmark agent must implement the atomic order bridge."));
    }
}
