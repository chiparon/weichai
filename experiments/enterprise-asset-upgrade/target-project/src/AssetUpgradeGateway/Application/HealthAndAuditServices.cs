namespace AssetUpgradeGateway.Application;

using System.Diagnostics;
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
            cancellationToken.ThrowIfCancellationRequested();
            var stopwatch = Stopwatch.StartNew();
            try
            {
                var result = await probe.CheckAsync(cancellationToken).ConfigureAwait(false);
                stopwatch.Stop();
                checks.Add(result);
            }
            catch (Exception exception)
            {
                stopwatch.Stop();
                var detail = $"{exception.GetType().Name}: {exception.Message}";
                checks.Add(new HealthCheckResult(probe.Name, Healthy: false, stopwatch.Elapsed, detail));
            }
        }

        return new ServiceHealthReport(clock.UtcNow, checks);
    }
}

public sealed class InMemoryHealthProbe : IHealthProbe
{
    private readonly Func<bool>? check;
    public InMemoryHealthProbe(string name, Func<bool>? check = null) { Name = name; this.check = check; }
    public string Name { get; }
    public Task<HealthCheckResult> CheckAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var healthy = check?.Invoke() ?? true;
        return Task.FromResult(new HealthCheckResult(Name, healthy, TimeSpan.Zero));
    }
}

public sealed class AuditQueryService
{
    private readonly IAuditQuery query;
    private readonly ITenantAuthorizer authorizer;
    public AuditQueryService(IAuditQuery query, ITenantAuthorizer authorizer) { this.query = query; this.authorizer = authorizer; }

    public async Task<IReadOnlyList<AuditRecord>> SearchAsync(AuditQuery request, string actorId, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!authorizer.CanAccess(request.TenantId, actorId))
        {
            return Array.Empty<AuditRecord>();
        }

        var records = await query.FindAsync(request.TenantId, request.SubjectId, request.From, request.To, cancellationToken).ConfigureAwait(false);
        if (request.Limit <= 0 || request.Limit >= records.Count)
        {
            return records;
        }

        return records.Take(request.Limit).ToList();
    }
}

public sealed class TenantBoundaryService
{
    private readonly ITenantAuthorizer authorizer;
    public TenantBoundaryService(ITenantAuthorizer authorizer) => this.authorizer = authorizer;

    public void Require(string tenantId, string actorId)
    {
        if (!authorizer.CanAccess(tenantId, actorId))
        {
            throw new UnauthorizedAccessException($"Actor '{actorId}' is not authorized for tenant '{tenantId}'.");
        }
    }

    public void RequireSame(string expectedTenant, string actualTenant)
    {
        if (!string.Equals(expectedTenant, actualTenant, StringComparison.Ordinal))
        {
            throw new UnauthorizedAccessException($"Tenant mismatch: expected '{expectedTenant}' but found '{actualTenant}'.");
        }
    }
}
