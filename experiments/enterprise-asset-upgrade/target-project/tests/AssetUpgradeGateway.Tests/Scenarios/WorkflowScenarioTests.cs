using AssetUpgradeGateway;
using AssetUpgradeGateway.Tests.Fixtures;
using Xunit;

namespace AssetUpgradeGateway.Tests.Scenarios;

public sealed class WorkflowScenarioTests
{
    [Fact]
    public async Task Approved_event_is_delivered_once()
    {
        var fixture = new ScenarioFixture();
        var service = fixture.WorkflowService();
        var result = await service.DeliverAsync(new(ScenarioFixture.TenantId, ScenarioFixture.ActorId, fixture.Event(), "corr-1"));
        Assert.True(result.Accepted);
        Assert.Equal(WorkflowState.Completed, result.State);
        Assert.Single(fixture.DispatchHistory.Snapshot());
    }

    [Fact]
    public async Task Repeated_delivery_is_reported_as_duplicate()
    {
        var fixture = new ScenarioFixture();
        var service = fixture.WorkflowService();
        var command = new WorkflowDeliveryCommand(ScenarioFixture.TenantId, ScenarioFixture.ActorId, fixture.Event(), "corr-2");
        await service.DeliverAsync(command);
        var second = await service.DeliverAsync(command);
        Assert.True(second.Accepted);
        Assert.Equal(DeliveryStatus.Duplicate, second.Status);
    }

    [Fact]
    public async Task Failed_delivery_enters_retry_state()
    {
        var fixture = new ScenarioFixture();
        var failing = new InMemoryWorkflowDispatcher(_ => DeliveryStatus.Retryable);
        var service = new WorkflowDeliveryCoordinator(fixture.Authorizer, failing, fixture.Events, fixture.DispatchHistory, fixture.DeadLetters, fixture.Audit, fixture.Metrics, fixture.Clock);
        var result = await service.DeliverAsync(new(ScenarioFixture.TenantId, ScenarioFixture.ActorId, fixture.Event("event-retry"), "corr-3"));
        Assert.False(result.Accepted);
        Assert.Equal(WorkflowState.RetryPending, result.State);
        Assert.Equal(DeliveryStatus.Retryable, result.Status);
    }

    [Fact]
    public void State_machine_rejects_completion_from_new()
    {
        var machine = new AssetUpgradeGateway.Policies.WorkflowStateTransitionPolicy();
        Assert.False(machine.CanTransition(WorkflowState.New, WorkflowState.Completed));
        Assert.Throws<InvalidOperationException>(() => machine.Transition(WorkflowState.New, WorkflowState.Completed));
    }

    [Fact]
    public void Retry_policy_caps_attempts()
    {
        var policy = new AssetUpgradeGateway.Policies.ExponentialRetryPolicy(new(2, TimeSpan.FromSeconds(1), TimeSpan.FromMinutes(1), 2, false));
        Assert.True(policy.CanRetry(0));
        Assert.True(policy.CanRetry(1));
        Assert.False(policy.CanRetry(2));
    }
}
