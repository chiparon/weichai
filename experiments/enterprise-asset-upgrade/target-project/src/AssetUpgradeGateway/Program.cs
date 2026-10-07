using AssetUpgradeGateway.Adapters;
using AssetUpgradeGateway.Policies;

namespace AssetUpgradeGateway;

public static class Program
{
    public static async Task Main(string[] args)
    {
        var composition = Compose();

        const string tenantId = "tenant-demo";
        const string actorId = "actor-demo";

        composition.Authorizer.Grant(tenantId, actorId);
        composition.Inventory.Seed("sku-demo", 10);

        var assetEvent = new AssetEvent(
            "event-demo",
            tenantId,
            "asset-demo",
            "asset.approved",
            DateTimeOffset.UtcNow);

        composition.EventStore.Add(new PendingEvent(assetEvent, DateTimeOffset.UtcNow, 0, true));

        // Exercise the workflow-delivery entry point. Each entry point is
        // isolated so a failure in one facade cannot prevent the others (in
        // particular reconciliation) from running.
        try
        {
            var delivery = await composition.Assets
                .SubmitAsync(actorId, assetEvent, null, CancellationToken.None)
                .ConfigureAwait(false);
            Console.WriteLine($"asset.submit accepted={delivery.Accepted} status={delivery.Status} detail={delivery.Detail ?? "<none>"}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"asset.submit error={ex.GetType().Name}: {ex.Message}");
        }

        var order = new OrderRequest(
            "order-demo",
            tenantId,
            actorId,
            new[] { new OrderLine("sku-demo", 1, 1000) },
            "USD");

        try
        {
            var orderResult = await composition.Orders
                .SubmitAsync(order, CancellationToken.None)
                .ConfigureAwait(false);
            Console.WriteLine($"order.submit accepted={orderResult.Accepted} status={orderResult.Status} reservation={orderResult.ReservationId ?? "<none>"} detail={orderResult.Detail ?? "<none>"}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"order.submit error={ex.GetType().Name}: {ex.Message}");
        }

        try
        {
            var report = await composition.Reconciliation
                .RunAsync(actorId, DateTimeOffset.UtcNow, 100, CancellationToken.None)
                .ConfigureAwait(false);
            Console.WriteLine($"reconciliation examined={report.Examined} retried={report.Retried} succeeded={report.Succeeded} failed={report.Failed} events={string.Join(",", report.EventIds)}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"reconciliation error={ex.GetType().Name}: {ex.Message}");
        }
    }

    public static GatewayComposition Compose()
    {
        var authorizer = new InMemoryTenantAuthorizer();
        var idempotency = new InMemoryIdempotencyStore();
        var audit = new InMemoryAuditSink();
        var quarantine = new InMemoryAttachmentQuarantine();
        var dispatcher = new InMemoryWorkflowDispatcher();
        var eventStore = new InMemoryRetryableEventStore();
        var validator = new OrderValidationPolicy();
        var inventory = new InMemoryInventoryGateway();
        var committer = new InMemoryOrderCommitter();

        var assets = new AssetUpgradeService(authorizer, quarantine, dispatcher, idempotency, audit);
        var orders = new OrderPluginBridge(validator, inventory, idempotency, committer, audit);
        var reconciliation = new ReconciliationService(authorizer, eventStore, dispatcher, idempotency, audit);

        return new GatewayComposition(
            authorizer,
            idempotency,
            audit,
            quarantine,
            dispatcher,
            eventStore,
            inventory,
            committer,
            assets,
            orders,
            reconciliation);
    }
}

public sealed record GatewayComposition(
    InMemoryTenantAuthorizer Authorizer,
    InMemoryIdempotencyStore Idempotency,
    InMemoryAuditSink Audit,
    InMemoryAttachmentQuarantine Quarantine,
    InMemoryWorkflowDispatcher Dispatcher,
    InMemoryRetryableEventStore EventStore,
    InMemoryInventoryGateway Inventory,
    InMemoryOrderCommitter Committer,
    AssetUpgradeService Assets,
    OrderPluginBridge Orders,
    ReconciliationService Reconciliation);
