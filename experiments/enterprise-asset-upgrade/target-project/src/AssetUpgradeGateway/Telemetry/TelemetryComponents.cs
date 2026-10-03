namespace AssetUpgradeGateway.Telemetry;

using System.Collections.Concurrent;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Ports;

public sealed record TraceSpan(string TraceId, string Name, DateTimeOffset StartedAt, DateTimeOffset? FinishedAt, IReadOnlyDictionary<string, string> Tags, bool Failed);

public interface ITraceSink
{
    void Write(TraceSpan span);
    IReadOnlyList<TraceSpan> Find(string traceId);
}

public sealed class InMemoryTraceSink : ITraceSink
{
    private readonly ConcurrentQueue<TraceSpan> spans = new();
    public void Write(TraceSpan span) => spans.Enqueue(span);
    public IReadOnlyList<TraceSpan> Find(string traceId) => spans.Where(x => x.TraceId == traceId).ToArray();
}

public sealed class TraceScope : IDisposable
{
    private readonly ITraceSink sink;
    private readonly DateTimeOffset started;
    private readonly string traceId;
    private readonly string name;
    private readonly IReadOnlyDictionary<string, string> tags;
    private bool disposed;
    public TraceScope(ITraceSink sink, string traceId, string name, IReadOnlyDictionary<string, string>? tags = null) { this.sink = sink; this.traceId = traceId; this.name = name; this.tags = tags ?? new Dictionary<string, string>(); started = DateTimeOffset.UtcNow; }
    public void Dispose() { if (disposed) return; disposed = true; sink.Write(new(traceId, name, started, DateTimeOffset.UtcNow, tags, false)); }
}

public sealed class TraceFactory
{
    private readonly ITraceSink sink;
    public TraceFactory(ITraceSink sink) => this.sink = sink;
    public TraceScope Start(string traceId, string operation, string tenantId, string actorId) => new(sink, traceId, operation, new Dictionary<string, string> { ["tenant"] = tenantId, ["actor"] = actorId });
}

public sealed class MetricsHealthProbe : Application.IHealthProbe
{
    private readonly IMetricsSink metrics;
    private readonly string tenantId;
    public MetricsHealthProbe(IMetricsSink metrics, string tenantId) { this.metrics = metrics; this.tenantId = tenantId; }
    public string Name => "metrics";
    public Task<HealthCheckResult> CheckAsync(CancellationToken cancellationToken)
    {
        var snapshot = metrics.Snapshot(tenantId);
        var healthy = snapshot.Counters.Values.All(x => x >= 0);
        return Task.FromResult(new HealthCheckResult(Name, healthy, TimeSpan.Zero, $"counters={snapshot.Counters.Count}"));
    }
}

public sealed class AuditMetricsDecorator : IAuditSink
{
    private readonly IAuditSink inner;
    private readonly IMetricsSink metrics;
    public AuditMetricsDecorator(IAuditSink inner, IMetricsSink metrics) { this.inner = inner; this.metrics = metrics; }
    public void Record(AuditRecord record) { inner.Record(record); metrics.Increment("audit.records", record.TenantId); }
}

public sealed class CorrelationContext : ICorrelationContext
{
    public CorrelationContext(string tenantId, string actorId, string correlationId) { TenantId = tenantId; ActorId = actorId; CorrelationId = correlationId; }
    public string CorrelationId { get; }
    public string ActorId { get; }
    public string TenantId { get; }
    public ICorrelationContext Child(string operation) => new CorrelationContext(TenantId, ActorId, CorrelationId + "/" + operation);
}
