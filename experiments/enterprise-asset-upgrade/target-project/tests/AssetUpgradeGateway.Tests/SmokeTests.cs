using AssetUpgradeGateway;

namespace AssetUpgradeGateway.Tests;

public sealed class SmokeTests
{
    [Fact]
    public void Target_contract_is_constructible()
    {
        Assert.NotNull(typeof(AssetUpgradeService));
        Assert.NotNull(typeof(AssetEvent));
    }
}
