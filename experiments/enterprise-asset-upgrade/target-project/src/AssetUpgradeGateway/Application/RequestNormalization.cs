namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;

public sealed class RequestNormalizer
{
    public AttachmentInput Normalize(AttachmentInput input)
    {
        var name = input.FileName.Trim().Normalize(System.Text.NormalizationForm.FormC);
        var type = input.DeclaredContentType.Trim().ToLowerInvariant();
        return input with { FileName = name, DeclaredContentType = type };
    }

    public OrderRequest Normalize(OrderRequest input)
    {
        var lines = input.Lines.Select(line => line with { Sku = line.Sku.Trim().ToUpperInvariant() }).ToArray();
        return input with { OrderId = input.OrderId.Trim(), TenantId = input.TenantId.Trim(), ActorId = input.ActorId.Trim(), Currency = input.Currency.Trim().ToUpperInvariant(), Lines = lines };
    }

    public AssetEvent Normalize(AssetEvent input)
    {
        return input with { EventId = input.EventId.Trim(), TenantId = input.TenantId.Trim(), AssetId = input.AssetId.Trim(), EventType = input.EventType.Trim().ToLowerInvariant() };
    }
}

public sealed class RequestFingerprint
{
    public string ForOrder(OrderRequest order)
    {
        var text = string.Join('|', order.TenantId, order.OrderId, order.Currency, string.Join(';', order.Lines.Select(x => $"{x.Sku}:{x.Quantity}:{x.UnitPriceMinor}")));
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    }
    public string ForEvent(AssetEvent assetEvent) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(string.Join('|', assetEvent.TenantId, assetEvent.AssetId, assetEvent.EventType, assetEvent.CreatedAt.UtcTicks)))).ToLowerInvariant();
}

public sealed class ErrorResponseFactory
{
    public IReadOnlyDictionary<string, object> Create(IEnumerable<ValidationIssue> issues, string correlationId)
        => new Dictionary<string, object> { ["correlationId"] = correlationId, ["errors"] = issues.Select(x => new { x.Code, x.Message, x.Severity }).ToArray() };
}
