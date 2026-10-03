using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Tests.Fixtures;
using Xunit;

namespace AssetUpgradeGateway.Tests.Scenarios;

public sealed class OrderScenarioTests
{
    [Fact]
    public async Task Valid_order_reserves_and_commits_atomically()
    {
        var fixture = new ScenarioFixture();
        var result = await fixture.OrderService().SubmitAsync(new(fixture.Order(), "corr-order-1"));
        Assert.True(result.Accepted);
        Assert.Equal(OrderLifecycleState.Accepted, result.State);
        Assert.NotNull(result.ReservationId);
        Assert.Single(fixture.Committer.Snapshot());
    }

    [Fact]
    public async Task Duplicate_order_is_idempotent()
    {
        var fixture = new ScenarioFixture();
        var service = fixture.OrderService();
        var command = new OrderSubmissionCommand(fixture.Order(), "corr-order-2");
        var first = await service.SubmitAsync(command);
        var second = await service.SubmitAsync(command);
        Assert.True(first.Accepted);
        Assert.True(second.Accepted);
        Assert.Contains(second.Issues, issue => issue.Code == "order.duplicate");
        Assert.Single(fixture.Committer.Snapshot());
    }

    [Fact]
    public async Task Insufficient_inventory_rejects_without_commit()
    {
        var fixture = new ScenarioFixture();
        var order = fixture.Order("order-short") with { Lines = [new("unknown", 1, 100)] };
        var result = await fixture.OrderService().SubmitAsync(new(order, "corr-order-3"));
        Assert.False(result.Accepted);
        Assert.Equal(OrderLifecycleState.Rejected, result.State);
        Assert.Empty(fixture.Committer.Snapshot());
    }

    [Fact]
    public void Inventory_reservation_checks_all_lines()
    {
        var reservation = new InventoryReservation("res", ScenarioFixture.TenantId, "order", new Dictionary<string, int> { ["sku-report"] = 1 }, DateTimeOffset.UtcNow.AddMinutes(1), false);
        var policy = new AssetUpgradeGateway.Policies.InventoryPolicy();
        var order = new OrderRequest("order", ScenarioFixture.TenantId, ScenarioFixture.ActorId, [new("sku-report", 1, 10), new("sku-archive", 1, 10)], "CNY");
        var result = policy.Evaluate(order, reservation);
        Assert.False(result.Allowed);
        Assert.Contains(result.Issues, issue => issue.Code == "inventory.reservation.incomplete");
    }

    [Fact]
    public void Price_policy_applies_segment_discount()
    {
        var policy = new AssetUpgradeGateway.Policies.PriceCalculationPolicy();
        var account = new CustomerAccount("c-1", ScenarioFixture.TenantId, "a@example.com", "CNY", new HashSet<string> { "employee" });
        var price = policy.Calculate(new OrderRequest("o", ScenarioFixture.TenantId, ScenarioFixture.ActorId, [new("sku-report", 2, 1000)], "CNY"), account);
        Assert.Equal(200, price.DiscountMinor);
        Assert.True(price.GrandTotalMinor > 0);
    }
}
