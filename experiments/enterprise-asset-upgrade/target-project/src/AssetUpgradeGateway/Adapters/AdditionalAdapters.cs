namespace AssetUpgradeGateway.Adapters;

using System.Collections.Concurrent;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Ports;

public sealed class InMemoryPolicyDecision : IPolicyDecision
{
    private readonly ConcurrentDictionary<string, IReadOnlyList<ValidationIssue>> decisions = new(StringComparer.Ordinal);
    public void Set(string subjectId, IReadOnlyList<ValidationIssue> issues) => decisions[subjectId] = issues;
    public Task<IReadOnlyList<ValidationIssue>> EvaluateAsync(OperationContext context, string subjectId, CancellationToken cancellationToken)
        => Task.FromResult(decisions.TryGetValue(subjectId, out var issues) ? issues : Array.Empty<ValidationIssue>());
}

public sealed class InMemoryDispatchHistoryReader
{
    private readonly IDispatchHistory history;
    public InMemoryDispatchHistoryReader(IDispatchHistory history) => this.history = history;
    public async Task<bool> HasSuccessfulAttemptAsync(string tenantId, string eventId, CancellationToken cancellationToken = default) => (await history.FindAsync(tenantId, eventId, cancellationToken)).Any(x => x.Status == DeliveryStatus.Accepted);
    public async Task<int> CountAttemptsAsync(string tenantId, string eventId, CancellationToken cancellationToken = default) => (await history.FindAsync(tenantId, eventId, cancellationToken)).Count;
}

public sealed class InMemoryAssetChangeLog
{
    private readonly ConcurrentQueue<(string Tenant, string Asset, string Action, DateTimeOffset At)> changes = new();
    public void Append(string tenantId, string assetId, string action, DateTimeOffset at) => changes.Enqueue((tenantId, assetId, action, at));
    public IReadOnlyList<(string Tenant, string Asset, string Action, DateTimeOffset At)> Find(string tenantId, string? assetId = null) => changes.Where(x => x.Tenant == tenantId && (assetId is null || x.Asset == assetId)).ToArray();
}

public sealed class InMemoryOperationLock
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> locks = new(StringComparer.Ordinal);
    public async Task<IDisposable> AcquireAsync(string key, CancellationToken cancellationToken = default)
    {
        var gate = locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        return new Releaser(gate);
    }
    private sealed class Releaser : IDisposable
    {
        private readonly SemaphoreSlim gate;
        public Releaser(SemaphoreSlim gate) => this.gate = gate;
        public void Dispose() => gate.Release();
    }
}

public sealed class InMemoryFeatureFlagSnapshot
{
    private readonly IFeatureFlags flags;
    public InMemoryFeatureFlagSnapshot(IFeatureFlags flags) => this.flags = flags;
    public IReadOnlyDictionary<string, bool> Capture(string tenantId, IEnumerable<string> names) => names.Distinct(StringComparer.OrdinalIgnoreCase).ToDictionary(name => name, name => flags.Enabled(tenantId, name), StringComparer.OrdinalIgnoreCase);
}

public sealed class CancellationAwareDispatcher : IWorkflowDispatcher
{
    private readonly IWorkflowDispatcher inner;
    public CancellationAwareDispatcher(IWorkflowDispatcher inner) => this.inner = inner;
    public async Task<DeliveryResult> DispatchAsync(AssetEvent assetEvent, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var result = await inner.DispatchAsync(assetEvent, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        return result;
    }
}
