namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Ports;

public interface IHealthProbe
{
    string Name { get; }
    Task<HealthCheckResult> CheckAsync(CancellationToken cancellationToken);
}

public sealed class HealthProbeRunner
{
    private readonly IReadOnlyList<IHealthProbe> probes;
    private readonly IClock clock;
    public HealthProbeRunner(IEnumerable<IHealthProbe> probes, IClock? clock = null) { this.probes = probes.ToArray(); this.clock = clock ?? new Adapters.SystemClock(); }
    public async Task<ServiceHealthReport> RunAsync(CancellationToken cancellationToken = default)
    {
        var checks = new List<HealthCheckResult>(probes.Count);
        foreach (var probe in probes)
        {
            try { checks.Add(await probe.CheckAsync(cancellationToken)); }
            catch (Exception exception) { checks.Add(new(probe.Name, false, TimeSpan.Zero, exception.Message)); }
        }
        return new(clock.UtcNow, checks);
    }
}

public sealed class InMemoryHealthProbe : IHealthProbe
{
    private readonly Func<bool> check;
    public InMemoryHealthProbe(string name, Func<bool>? check = null) { Name = name; this.check = check ?? (() => true); }
    public string Name { get; }
    public Task<HealthCheckResult> CheckAsync(CancellationToken cancellationToken) => Task.FromResult(new HealthCheckResult(Name, check(), TimeSpan.Zero));
}

public sealed class AuditQueryService
{
    private readonly IAuditQuery query;
    private readonly ITenantAuthorizer authorizer;
    public AuditQueryService(IAuditQuery query, ITenantAuthorizer authorizer) { this.query = query; this.authorizer = authorizer; }
    public Task<IReadOnlyList<AuditRecord>> SearchAsync(AuditQuery request, string actorId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(request.TenantId, actorId)) throw new UnauthorizedAccessException("Actor cannot inspect tenant audit records.");
        return query.FindAsync(request.TenantId, request.SubjectId, request.From, request.To, cancellationToken);
    }
}

public sealed class TenantBoundaryService
{
    private readonly ITenantAuthorizer authorizer;
    public TenantBoundaryService(ITenantAuthorizer authorizer) => this.authorizer = authorizer;
    public void Require(string tenantId, string actorId) { if (!authorizer.CanAccess(tenantId, actorId)) throw new UnauthorizedAccessException("Tenant boundary denied the operation."); }
    public void RequireSame(string expectedTenant, string actualTenant) { if (!string.Equals(expectedTenant, actualTenant, StringComparison.Ordinal)) throw new UnauthorizedAccessException("Cross-tenant data access is not allowed."); }
}
