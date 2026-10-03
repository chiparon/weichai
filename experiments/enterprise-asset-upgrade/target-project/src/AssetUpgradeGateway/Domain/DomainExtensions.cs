namespace AssetUpgradeGateway.Domain;

using AssetUpgradeGateway;

public static class DomainExtensions
{
    public static bool ContainsAll(this InventoryReservation reservation, IReadOnlyList<OrderLine> lines)
        => lines.All(line => reservation.Contains(line.Sku, line.Quantity));

    public static bool IsTerminal(this WorkflowState state)
        => state is WorkflowState.Completed or WorkflowState.Failed;

    public static bool IsTerminal(this EventProcessingStage stage)
        => stage is EventProcessingStage.Completed or EventProcessingStage.DeadLettered;

    public static long MerchandiseTotal(this OrderRequest order)
        => order.Lines.Sum(line => checked((long)line.Quantity * line.UnitPriceMinor));

    public static string StableFingerprint(this AttachmentInput attachment)
    {
        var hash = System.Security.Cryptography.SHA256.HashData(attachment.Content.Span);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    public static AssetEvent WithState(this AssetEvent assetEvent, WorkflowState state)
        => assetEvent with { State = state };
}
