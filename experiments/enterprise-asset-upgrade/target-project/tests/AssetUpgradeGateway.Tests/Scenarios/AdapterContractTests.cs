using AssetUpgradeGateway;
using AssetUpgradeGateway.Adapters;
using AssetUpgradeGateway.Application;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Tests.Fixtures;
using Xunit;

namespace AssetUpgradeGateway.Tests.Scenarios;

public sealed class AdapterContractTests
{
    [Fact]
    public async Task Lease_store_allows_only_one_owner_until_release()
    {
        var leases = new InMemoryLeaseStore();
        Assert.True(await leases.TryClaimAsync("tenant", "job", TimeSpan.FromMinutes(1), default));
        Assert.False(await leases.TryClaimAsync("tenant", "job", TimeSpan.FromMinutes(1), default));
        await leases.ReleaseAsync("tenant", "job", default);
        Assert.True(await leases.TryClaimAsync("tenant", "job", TimeSpan.FromMinutes(1), default));
    }

    [Fact]
    public async Task Transaction_boundary_serializes_commit()
    {
        var boundary = new InMemoryTransactionBoundary();
        var order = new List<int>();
        await boundary.ExecuteAsync(async _ => { order.Add(1); await Task.Yield(); order.Add(2); return true; }, default);
        Assert.Equal(new[] { 1, 2 }, order);
    }

    [Fact]
    public async Task Asset_repository_paginates_by_tenant()
    {
        var repository = new InMemoryAssetRepository();
        for (var index = 0; index < 5; index++) await repository.SaveAsync(new AssetAggregate(new AssetDescriptor($"asset-{index}", ScenarioFixture.TenantId, AssetKind.Document, $"external-{index}")), default);
        var first = await repository.SearchAsync(ScenarioFixture.TenantId, null, 2, default);
        var second = await repository.SearchAsync(ScenarioFixture.TenantId, first.ContinuationToken, 2, default);
        Assert.Equal(2, first.Items.Count);
        Assert.Equal(2, second.Items.Count);
        Assert.True(first.HasMore);
    }

    [Fact]
    public async Task Feature_flag_snapshot_is_consistent()
    {
        var flags = new InMemoryFeatureFlags();
        flags.Set(ScenarioFixture.TenantId, "workflow.v2", true);
        var snapshot = new InMemoryFeatureFlagSnapshot(flags).Capture(ScenarioFixture.TenantId, ["workflow.v2", "workflow.v3"]);
        Assert.True(snapshot["workflow.v2"]);
        Assert.False(snapshot["workflow.v3"]);
    }
}
