using AssetUpgradeGateway;
using Xunit;

namespace AssetUpgradeGateway.Tests;

public sealed class SmokeTests
{
    [Fact]
    public void Target_contract_is_constructible()
    {
        Assert.NotNull(typeof(AssetUpgradeService));
        Assert.NotNull(typeof(AssetEvent));
        Assert.NotNull(typeof(ReconciliationService));
        Assert.NotNull(typeof(OrderPluginBridge));
    }
}
