namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Ports;

public sealed record PluginRegistrationCommand(string TenantId, string ActorId, PluginDescriptor Descriptor);

public sealed class PluginRegistryService
{
    private readonly IPluginRegistry registry;
    private readonly ITenantAuthorizer authorizer;
    private readonly IAuditSink audit;
    public PluginRegistryService(IPluginRegistry registry, ITenantAuthorizer authorizer, IAuditSink audit) { this.registry = registry; this.authorizer = authorizer; this.audit = audit; }
    public async Task<PolicyResult> RegisterAsync(PluginRegistrationCommand command, CancellationToken cancellationToken = default)
    {
        var issues = new List<ValidationIssue>();
        if (!authorizer.CanAccess(command.TenantId, command.ActorId)) issues.Add(new("tenant.access.denied", "Actor cannot register a plugin.", ValidationSeverity.Error));
        if (!string.Equals(command.TenantId, command.Descriptor.TenantId, StringComparison.Ordinal)) issues.Add(new("plugin.tenant", "Plugin tenant does not match command tenant.", ValidationSeverity.Error));
        if (string.IsNullOrWhiteSpace(command.Descriptor.PluginId)) issues.Add(new("plugin.id.empty", "Plugin id is required.", ValidationSeverity.Error));
        if (command.Descriptor.Capabilities.Count == 0) issues.Add(new("plugin.capability.empty", "Plugin must declare a capability.", ValidationSeverity.Error));
        if (issues.Any(x => x.BlocksOperation)) return PolicyResult.Deny([.. issues]);
        await registry.RegisterAsync(command.Descriptor, cancellationToken);
        audit.Record(new(command.TenantId, command.Descriptor.PluginId, "plugin.register", "accepted", DateTimeOffset.UtcNow));
        return new(true, issues);
    }
    public Task<IReadOnlyList<PluginDescriptor>> ListAsync(string tenantId, string actorId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId)) throw new UnauthorizedAccessException("Actor cannot list plugins.");
        return registry.ListAsync(tenantId, cancellationToken);
    }
    public async Task<PolicyResult> DisableAsync(string tenantId, string actorId, string pluginId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId)) return PolicyResult.Deny(new("tenant.access.denied", "Actor cannot disable a plugin.", ValidationSeverity.Error));
        var current = (await registry.ListAsync(tenantId, cancellationToken)).FirstOrDefault(x => x.PluginId == pluginId);
        if (current is null) return PolicyResult.Deny(new("plugin.missing", "Plugin was not found.", ValidationSeverity.Error));
        await registry.RegisterAsync(current.Disable(), cancellationToken);
        audit.Record(new(tenantId, pluginId, "plugin.disable", "accepted", DateTimeOffset.UtcNow));
        return PolicyResult.Allow();
    }
}

public sealed class OrderCommandRouter
{
    private readonly OrderPluginValidationService plugins;
    private readonly OrderLifecycleService orders;
    public OrderCommandRouter(OrderPluginValidationService plugins, OrderLifecycleService orders) { this.plugins = plugins; this.orders = orders; }
    public async Task<OrderSubmissionResult?> RouteAsync(OrderCommand command, OrderRequest request, CancellationToken cancellationToken = default)
    {
        var decision = await plugins.EvaluateAsync(command, cancellationToken);
        if (!decision.Allowed) return new(false, OrderLifecycleState.Rejected, null, null, decision.Issues, []);
        return await orders.SubmitAsync(new(request, command.CommandId), cancellationToken);
    }
}
