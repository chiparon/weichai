namespace AssetUpgradeGateway.Application;

using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;

public sealed class RequestNormalizer
{
    public AttachmentInput Normalize(AttachmentInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        return input with
        {
            AttachmentId = Trim(input.AttachmentId),
            TenantId = Trim(input.TenantId),
            FileName = Trim(input.FileName),
            DeclaredContentType = Trim(input.DeclaredContentType).ToLowerInvariant(),
        };
    }

    public OrderRequest Normalize(OrderRequest input)
    {
        ArgumentNullException.ThrowIfNull(input);
        var lines = (input.Lines ?? Array.Empty<OrderLine>())
            .Where(line => line is not null && line.Quantity > 0)
            .OrderBy(line => line.Sku, StringComparer.Ordinal)
            .ToList();

        return input with
        {
            OrderId = Trim(input.OrderId),
            TenantId = Trim(input.TenantId),
            ActorId = Trim(input.ActorId),
            Currency = Trim(input.Currency).ToUpperInvariant(),
            Lines = lines,
        };
    }

    public AssetEvent Normalize(AssetEvent input)
    {
        ArgumentNullException.ThrowIfNull(input);
        return input with
        {
            EventId = Trim(input.EventId),
            TenantId = Trim(input.TenantId),
            AssetId = Trim(input.AssetId),
            EventType = Trim(input.EventType),
            AttachmentId = input.AttachmentId is null ? null : input.AttachmentId.Trim(),
        };
    }

    private static string Trim(string value) => value is null ? string.Empty : value.Trim();
}

public sealed class RequestFingerprint
{
    private const char FieldSeparator = '\u001f';
    private const char LineSeparator = '\u001e';

    public string ForOrder(OrderRequest order)
    {
        ArgumentNullException.ThrowIfNull(order);
        var builder = new StringBuilder();
        builder.Append(order.TenantId).Append(FieldSeparator);
        builder.Append(order.OrderId).Append(FieldSeparator);
        builder.Append(order.Currency).Append(FieldSeparator);

        var lines = order.Lines ?? Array.Empty<OrderLine>();
        foreach (var line in lines.OrderBy(line => line.Sku, StringComparer.Ordinal))
        {
            builder.Append(line.Sku).Append(LineSeparator);
            builder.Append(line.Quantity.ToString(CultureInfo.InvariantCulture)).Append(LineSeparator);
            builder.Append(line.UnitPriceMinor.ToString(CultureInfo.InvariantCulture)).Append(FieldSeparator);
        }

        return Hash(builder.ToString());
    }

    public string ForEvent(AssetEvent assetEvent)
    {
        ArgumentNullException.ThrowIfNull(assetEvent);
        var builder = new StringBuilder();
        builder.Append(assetEvent.EventId).Append(FieldSeparator);
        builder.Append(assetEvent.TenantId).Append(FieldSeparator);
        builder.Append(assetEvent.AssetId).Append(FieldSeparator);
        builder.Append(assetEvent.EventType).Append(FieldSeparator);
        builder.Append(assetEvent.AttachmentId ?? string.Empty);
        return Hash(builder.ToString());
    }

    private static string Hash(string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}

public sealed class ErrorResponseFactory
{
    public IReadOnlyDictionary<string, object> Create(IEnumerable<ValidationIssue> issues, string correlationId)
    {
        var materialized = issues?.ToList() ?? new List<ValidationIssue>();
        var payload = materialized
            .Select(issue => (object)new Dictionary<string, object>(StringComparer.Ordinal)
            {
                ["code"] = issue.Code,
                ["message"] = issue.Message,
                ["severity"] = issue.Severity.ToString(),
                ["blocks"] = issue.BlocksOperation,
            })
            .ToList();

        return new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["correlationId"] = correlationId ?? string.Empty,
            ["count"] = materialized.Count,
            ["blocked"] = materialized.Any(issue => issue.BlocksOperation),
            ["issues"] = payload,
        };
    }
}
