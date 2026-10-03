using AssetUpgradeGateway;
using AssetUpgradeGateway.Application;
using Xunit;

namespace AssetUpgradeGateway.Tests.Scenarios;

public sealed class NormalizationScenarioTests
{
    [Fact]
    public void Attachment_normalizer_canonicalizes_name_and_content_type()
    {
        var input = new AttachmentInput("a", "tenant", " report.PDF ", " Application/PDF ", new byte[] { 1 }, true);
        var normalized = new RequestNormalizer().Normalize(input);
        Assert.Equal("report.PDF", normalized.FileName);
        Assert.Equal("application/pdf", normalized.DeclaredContentType);
    }

    [Fact]
    public void Order_normalizer_merges_boundary_formatting()
    {
        var order = new OrderRequest(" order ", " tenant ", " actor ", [new(" sku-1 ", 1, 10)], " cny ");
        var normalized = new RequestNormalizer().Normalize(order);
        Assert.Equal("order", normalized.OrderId);
        Assert.Equal("SKU-1", normalized.Lines[0].Sku);
        Assert.Equal("CNY", normalized.Currency);
    }

    [Fact]
    public void Fingerprint_changes_when_order_line_changes()
    {
        var fingerprint = new RequestFingerprint();
        var first = new OrderRequest("o", "t", "a", [new("SKU", 1, 10)], "CNY");
        var second = first with { Lines = [new("SKU", 2, 10)] };
        Assert.NotEqual(fingerprint.ForOrder(first), fingerprint.ForOrder(second));
    }

    [Fact]
    public void Error_response_contains_correlation_and_codes()
    {
        var response = new ErrorResponseFactory().Create([new ValidationIssue("x", "bad", ValidationSeverity.Error)], "corr");
        Assert.Equal("corr", response["correlationId"]);
        Assert.NotNull(response["errors"]);
    }
}

    [Fact]
    public void Event_fingerprint_is_stable_for_same_payload()
    {
        var fingerprint = new RequestFingerprint();
        var eventValue = new AssetEvent("e", "t", "a", "changed", DateTimeOffset.UnixEpoch);
        Assert.Equal(fingerprint.ForEvent(eventValue), fingerprint.ForEvent(eventValue));
    }

    [Fact]
    public void Validation_issue_catalog_describes_registered_codes()
    {
        var catalog = new ValidationIssueCatalog();
        Assert.True(catalog.Contains("order.duplicate"));
        Assert.NotEmpty(catalog.Describe("order.duplicate"));
    }
}

    [Fact]
    public void Normalizer_preserves_attachment_content_and_scan_flag()
    {
        var bytes = new byte[] { 1, 2, 3 };
        var input = new AttachmentInput("a", "tenant", "a.txt", "text/plain", bytes, true);
        var normalized = new RequestNormalizer().Normalize(input);
        Assert.Equal(bytes, normalized.Content.ToArray());
        Assert.True(normalized.Scanned);
    }

    [Fact]
    public void Normalizer_keeps_event_state()
    {
        var value = new AssetEvent("e", "t", "a", "changed", DateTimeOffset.UnixEpoch) { State = WorkflowState.Completed };
        Assert.Equal(WorkflowState.Completed, new RequestNormalizer().Normalize(value).State);
    }
