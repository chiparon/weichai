using AssetUpgradeGateway;
using AssetUpgradeGateway.Adapters;
using AssetUpgradeGateway.Application;
using AssetUpgradeGateway.Tests.Fixtures;
using Xunit;

namespace AssetUpgradeGateway.Tests.Scenarios;

public sealed class ReconciliationScenarioTests
{
    [Fact]
    public async Task Due_retry_is_dispatched_and_checkpointed()
    {
        var fixture = new ScenarioFixture();
        fixture.Events.Add(new PendingEvent(fixture.Event("event-due"), fixture.Clock.UtcNow.AddMinutes(-1), 1, true));
        var checkpoints = new InMemoryCheckpointStore();
        var leases = new InMemoryLeaseStore();
        var service = new ReconciliationOrchestrator(fixture.Authorizer, fixture.Events, fixture.Dispatcher, fixture.Idempotency, fixture.Audit, checkpoints, leases, fixture.Metrics);
        var outcome = await service.RunAsync(new(ScenarioFixture.TenantId, ScenarioFixture.ActorId, fixture.Clock.UtcNow, 10, "asset-reconcile"));
        Assert.Equal(1, outcome.Report.Examined);
        Assert.Equal(1, outcome.Report.Succeeded);
        Assert.Equal("event-due", outcome.Checkpoint);
        Assert.Equal("event-due", await checkpoints.GetAsync(ScenarioFixture.TenantId, "asset-reconcile", default));
    }

    [Fact]
    public async Task Unauthorized_reconciliation_does_not_touch_store()
    {
        var fixture = new ScenarioFixture();
        var service = new ReconciliationOrchestrator(fixture.Authorizer, fixture.Events, fixture.Dispatcher, fixture.Idempotency, fixture.Audit, new InMemoryCheckpointStore(), new InMemoryLeaseStore(), fixture.Metrics);
        var outcome = await service.RunAsync(new(ScenarioFixture.TenantId, "unknown", fixture.Clock.UtcNow, 10, "asset-reconcile"));
        Assert.Empty(outcome.Report.EventIds);
        Assert.Contains(outcome.Issues, issue => issue.Code == "tenant.access.denied");
    }

    [Fact]
    public void Due_window_includes_boundaries()
    {
        var calculator = new DueWindowCalculator();
        var now = DateTimeOffset.UtcNow;
        var window = calculator.Compute(now, TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5), 20);
        Assert.True(calculator.Contains(window, window.From));
        Assert.True(calculator.Contains(window, window.To));
        Assert.False(calculator.Contains(window, window.To.AddTicks(1)));
    }
}
