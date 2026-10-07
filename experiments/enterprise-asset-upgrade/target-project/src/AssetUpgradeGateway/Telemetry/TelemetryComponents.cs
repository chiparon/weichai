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
    public void Write(TraceSpan span)
    {
        ArgumentNullException.ThrowIfNull(span);
        spans.Enqueue(span);
    }

    public IReadOnlyList<TraceSpan> Find(string traceId)
    {
        return spans
            .Where(span => string.Equals(span.TraceId, traceId, StringComparison.Ordinal))
            .ToList();
    }
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
    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        sink.Write(new TraceSpan(traceId, name, started, DateTimeOffset.UtcNow, tags, Failed: false));
    }
}

public sealed class TraceFactory
{
    private readonly ITraceSink sink;
    public TraceFactory(ITraceSink sink) => this.sink = sink;
    public TraceScope Start(string traceId, string operation, string tenantId, string actorId)
    {
        var tags = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["tenantId"] = tenantId,
            ["actorId"] = actorId,
            ["operation"] = operation,
        };
        return new TraceScope(sink, traceId, operation, tags);
    }
}

public sealed class MetricsHealthProbe : Application.IHealthProbe
{
    private readonly IMetricsSink metrics;
    private readonly string tenantId;
    public MetricsHealthProbe(IMetricsSink metrics, string tenantId) { this.metrics = metrics; this.tenantId = tenantId; }
    public string Name => $"metrics:{tenantId}";
    public Task<HealthCheckResult> CheckAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var snapshot = metrics.Snapshot(tenantId);
            stopwatch.Stop();
            var detail = $"counters={snapshot.Counters.Count}; timings={snapshot.Timings.Count}";
            return Task.FromResult(new HealthCheckResult(Name, Healthy: true, stopwatch.Elapsed, detail));
        }
        catch (Exception exception)
        {
            stopwatch.Stop();
            return Task.FromResult(new HealthCheckResult(Name, Healthy: false, stopwatch.Elapsed, exception.Message));
        }
    }
}

public sealed class AuditMetricsDecorator : IAuditSink
{
    private readonly IAuditSink inner;
    private readonly IMetricsSink metrics;
    public AuditMetricsDecorator(IAuditSink inner, IMetricsSink metrics) { this.inner = inner; this.metrics = metrics; }
    public void Record(AuditRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);
        inner.Record(record);
        metrics.Increment("audit.records", record.TenantId);
    }
}

public sealed class CorrelationContext : ICorrelationContext
{
    public CorrelationContext(string tenantId, string actorId, string correlationId) { TenantId = tenantId; ActorId = actorId; CorrelationId = correlationId; }
    public string CorrelationId { get; }
    public string ActorId { get; }
    public string TenantId { get; }
    public ICorrelationContext Child(string operation)
    {
        if (string.IsNullOrWhiteSpace(operation))
        {
            throw new ArgumentException("Operation must be provided.", nameof(operation));
        }

        return new CorrelationContext(TenantId, ActorId, $"{CorrelationId}/{operation}");
    }
}
