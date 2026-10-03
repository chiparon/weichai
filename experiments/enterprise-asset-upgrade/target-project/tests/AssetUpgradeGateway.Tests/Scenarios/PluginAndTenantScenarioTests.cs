using AssetUpgradeGateway;
using AssetUpgradeGateway.Adapters;
using AssetUpgradeGateway.Application;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Policies;
using Xunit;

namespace AssetUpgradeGateway.Tests.Scenarios;

public sealed class PluginAndTenantScenarioTests
{
    [Fact]
    public async Task Plugin_capability_is_scoped_to_tenant()
    {
        var registry = new InMemoryPluginRegistry();
        await registry.RegisterAsync(new("tax-plugin", "tenant-acme", "Tax", new Version(2, 1), new HashSet<string> { "calculate-tax" }, true), default);
        var service = new OrderPluginValidationService(registry);
        var allowed = await service.EvaluateAsync(new("tenant-acme", "operator", "order-1", "command-1", "calculate-tax"));
        var denied = await service.EvaluateAsync(new("tenant-other", "operator", "order-1", "command-2", "calculate-tax"));
        Assert.True(allowed.Allowed);
        Assert.False(denied.Allowed);
    }

    [Fact]
    public void Tenant_scope_rejects_expired_permission()
    {
        var scope = new TenantScope("tenant-acme", "operator", new HashSet<string>(), new HashSet<string> { "asset.submit" }, DateTimeOffset.UtcNow.AddMinutes(-1));
        var policy = new TenantAttachmentPolicy();
        var attachment = new AttachmentInput("a", "tenant-acme", "a.txt", "text/plain", new byte[] { 0x61 }, true);
        var result = policy.Evaluate(scope, attachment, "asset.submit");
        Assert.False(result.Allowed);
        Assert.Contains(result.Issues, issue => issue.Code == "tenant.scope.expired");
    }

    [Fact]
    public async Task Asset_coordinator_persists_event_and_attachment()
    {
        var fixture = new AssetUpgradeGateway.Tests.Fixtures.ScenarioFixture();
        var assets = new InMemoryAssetRepository();
        var service = new AssetLifecycleCoordinator(fixture.AttachmentService(), fixture.WorkflowService(), assets, fixture.Audit, fixture.Clock);
        var descriptor = new AssetDescriptor("asset-42", ScenarioFixture.TenantId, AssetKind.Document, "customer/report");
        var result = await service.SubmitAsync(new(ScenarioFixture.TenantId, ScenarioFixture.ActorId, descriptor, fixture.Pdf("a-42"), "asset.created", "corr-42"));
        Assert.True(result.Accepted);
        var saved = await assets.FindAsync(ScenarioFixture.TenantId, "asset-42", default);
        Assert.NotNull(saved);
        Assert.Single(saved!.Events);
    }
}
