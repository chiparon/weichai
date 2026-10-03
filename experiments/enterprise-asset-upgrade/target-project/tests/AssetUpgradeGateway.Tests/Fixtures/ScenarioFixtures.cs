using AssetUpgradeGateway;
using AssetUpgradeGateway.Adapters;
using AssetUpgradeGateway.Application;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;

namespace AssetUpgradeGateway.Tests.Fixtures;

public sealed class ScenarioFixture
{
    public ScenarioFixture()
    {
        Clock = new ManualClock(new DateTimeOffset(2026, 1, 1, 8, 0, 0, TimeSpan.Zero));
        Authorizer = new InMemoryTenantAuthorizer();
        Authorizer.Grant(TenantId, ActorId, "asset.submit", "order.submit", "audit.read", "*");
        Audit = new InMemoryAuditSink();
        Metrics = new InMemoryMetricsSink();
        Attachments = new InMemoryAttachmentRepository();
        Scanner = new InMemoryAttachmentScanner(Clock);
        Quarantine = new InMemoryQuarantineLog();
        Idempotency = new InMemoryIdempotencyStore();
        Events = new InMemoryRetryableEventStore();
        DispatchHistory = new InMemoryDispatchHistory();
        Dispatcher = new InMemoryWorkflowDispatcher();
        DeadLetters = new InMemoryDeadLetterSink();
        Orders = new InMemoryOrderRepository();
        Inventory = new InMemoryInventoryGateway(Clock);
        Committer = new InMemoryOrderCommitter(Clock);
        Transaction = new InMemoryTransactionBoundary();
        Inventory.Seed("sku-report", 100);
        Inventory.Seed("sku-archive", 20);
    }

    public const string TenantId = "tenant-acme";
    public const string OtherTenantId = "tenant-other";
    public const string ActorId = "operator-1";
    public ManualClock Clock { get; }
    public InMemoryTenantAuthorizer Authorizer { get; }
    public InMemoryAuditSink Audit { get; }
    public InMemoryMetricsSink Metrics { get; }
    public InMemoryAttachmentRepository Attachments { get; }
    public InMemoryAttachmentScanner Scanner { get; }
    public InMemoryQuarantineLog Quarantine { get; }
    public InMemoryIdempotencyStore Idempotency { get; }
    public InMemoryRetryableEventStore Events { get; }
    public InMemoryDispatchHistory DispatchHistory { get; }
    public InMemoryWorkflowDispatcher Dispatcher { get; }
    public InMemoryDeadLetterSink DeadLetters { get; }
    public InMemoryOrderRepository Orders { get; }
    public InMemoryInventoryGateway Inventory { get; }
    public InMemoryOrderCommitter Committer { get; }
    public InMemoryTransactionBoundary Transaction { get; }

    public AttachmentInput Pdf(string id = "attachment-1") => new(id, TenantId, $"{id}.pdf", "application/pdf", new byte[] { 0x25, 0x50, 0x44, 0x46, 0x2d, 0x31 }, true);
    public AttachmentInput UnsafeName(string id = "attachment-bad") => new(id, TenantId, "../secret.txt", "text/plain", new byte[] { 0x73, 0x65, 0x63 }, true);
    public AssetEvent Event(string id = "event-1", string? attachmentId = null) => new(id, TenantId, "asset-1", "asset.updated", Clock.UtcNow, attachmentId) { State = WorkflowState.Approved };
    public OrderRequest Order(string id = "order-1") => new(id, TenantId, ActorId, [new("sku-report", 2, 1500), new("sku-archive", 1, 2200)], "CNY");

    public AttachmentIntakeService AttachmentService() => new(Authorizer, Attachments, Scanner, Quarantine, Audit, Metrics, Clock);
    public WorkflowDeliveryCoordinator WorkflowService() => new(Authorizer, Dispatcher, Events, DispatchHistory, DeadLetters, Audit, Metrics, Clock);
    public OrderLifecycleService OrderService() => new(new OrderValidationPolicy(), Inventory, Committer, Orders, Idempotency, Audit, Transaction, Clock);
}

public static class FixtureAssertions
{
    public static void AssertTenant(string expected, string actual) => Xunit.Assert.Equal(expected, actual);
    public static void AssertNoErrors(IReadOnlyList<ValidationIssue> issues) => Xunit.Assert.DoesNotContain(issues, issue => issue.BlocksOperation);
    public static void AssertContainsCode(IReadOnlyList<ValidationIssue> issues, string code) => Xunit.Assert.Contains(issues, issue => issue.Code == code);
    public static void AssertTerminal(OrderLifecycleState state) => Xunit.Assert.Contains(state, new[] { OrderLifecycleState.Accepted, OrderLifecycleState.Rejected, OrderLifecycleState.RolledBack });
}
