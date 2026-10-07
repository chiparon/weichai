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
        ArgumentNullException.ThrowIfNull(command);
        if (!authorizer.CanAccess(command.TenantId, command.ActorId))
        {
            return PolicyResult.Deny(new ValidationIssue("plugin.forbidden", "Actor is not authorized for the tenant.", ValidationSeverity.Error));
        }

        var descriptor = command.Descriptor;
        foreach (var capability in descriptor.Capabilities)
        {
            var existing = await registry.FindCapabilityAsync(command.TenantId, capability, cancellationToken).ConfigureAwait(false);
            if (existing is not null && !string.Equals(existing.PluginId, descriptor.PluginId, StringComparison.Ordinal))
            {
                return PolicyResult.Deny(new ValidationIssue("plugin.exists", $"Capability '{capability}' is already registered by plugin '{existing.PluginId}'.", ValidationSeverity.Error));
            }
        }

        await registry.RegisterAsync(descriptor, cancellationToken).ConfigureAwait(false);
        audit.Record(new AuditRecord(command.TenantId, descriptor.PluginId, "plugin.registered", "registered", DateTimeOffset.UtcNow));
        return PolicyResult.Allow();
    }

    public async Task<IReadOnlyList<PluginDescriptor>> ListAsync(string tenantId, string actorId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId))
        {
            return Array.Empty<PluginDescriptor>();
        }

        return await registry.ListAsync(tenantId, cancellationToken).ConfigureAwait(false);
    }

    public async Task<PolicyResult> DisableAsync(string tenantId, string actorId, string pluginId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId))
        {
            return PolicyResult.Deny(new ValidationIssue("plugin.forbidden", "Actor is not authorized for the tenant.", ValidationSeverity.Error));
        }

        var descriptors = await registry.ListAsync(tenantId, cancellationToken).ConfigureAwait(false);
        var descriptor = descriptors.FirstOrDefault(item => string.Equals(item.PluginId, pluginId, StringComparison.Ordinal));
        if (descriptor is null)
        {
            return PolicyResult.Deny(new ValidationIssue("plugin.missing", $"Plugin '{pluginId}' is not registered for the tenant.", ValidationSeverity.Error));
        }

        await registry.RegisterAsync(descriptor.Disable(), cancellationToken).ConfigureAwait(false);
        audit.Record(new AuditRecord(tenantId, descriptor.PluginId, "plugin.disabled", "disabled", DateTimeOffset.UtcNow));
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
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(request);

        var decision = await plugins.EvaluateAsync(command, cancellationToken).ConfigureAwait(false);
        if (!decision.Allowed)
        {
            return new OrderSubmissionResult(false, OrderLifecycleState.Rejected, null, null, decision.Issues, Array.Empty<string>());
        }

        var normalized = new RequestNormalizer().Normalize(request);
        return await orders.SubmitAsync(new OrderSubmissionCommand(normalized, command.CommandId), cancellationToken).ConfigureAwait(false);
    }
}
