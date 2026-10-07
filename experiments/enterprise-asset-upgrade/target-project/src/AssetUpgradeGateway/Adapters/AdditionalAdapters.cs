namespace AssetUpgradeGateway.Adapters;

using System.Collections.Concurrent;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Ports;

public sealed class InMemoryPolicyDecision : IPolicyDecision
{
    private readonly ConcurrentDictionary<string, IReadOnlyList<ValidationIssue>> decisions = new(StringComparer.Ordinal);
    public void Set(string subjectId, IReadOnlyList<ValidationIssue> issues) => decisions[subjectId] = issues ?? Array.Empty<ValidationIssue>();
    public Task<IReadOnlyList<ValidationIssue>> EvaluateAsync(OperationContext context, string subjectId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        IReadOnlyList<ValidationIssue> issues = decisions.TryGetValue(subjectId, out var stored)
            ? stored
            : Array.Empty<ValidationIssue>();
        return Task.FromResult(issues);
    }
}

public sealed class InMemoryDispatchHistoryReader
{
    private readonly IDispatchHistory history;
    public InMemoryDispatchHistoryReader(IDispatchHistory history) => this.history = history;
    public async Task<bool> HasSuccessfulAttemptAsync(string tenantId, string eventId, CancellationToken cancellationToken = default)
    {
        var attempts = await history.FindAsync(tenantId, eventId, cancellationToken).ConfigureAwait(false);
        return attempts.Any(attempt => attempt.Status == DeliveryStatus.Accepted);
    }
    public async Task<int> CountAttemptsAsync(string tenantId, string eventId, CancellationToken cancellationToken = default)
    {
        var attempts = await history.FindAsync(tenantId, eventId, cancellationToken).ConfigureAwait(false);
        return attempts.Count;
    }
}

public sealed class InMemoryAssetChangeLog
{
    private readonly ConcurrentQueue<(string Tenant, string Asset, string Action, DateTimeOffset At)> changes = new();
    public void Append(string tenantId, string assetId, string action, DateTimeOffset at) => changes.Enqueue((tenantId, assetId, action, at));
    public IReadOnlyList<(string Tenant, string Asset, string Action, DateTimeOffset At)> Find(string tenantId, string? assetId = null)
    {
        return changes
            .Where(change => string.Equals(change.Tenant, tenantId, StringComparison.Ordinal))
            .Where(change => assetId is null || string.Equals(change.Asset, assetId, StringComparison.Ordinal))
            .OrderBy(change => change.At)
            .ToList();
    }
}

public sealed class InMemoryOperationLock
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> locks = new(StringComparer.Ordinal);
    public async Task<IDisposable> AcquireAsync(string key, CancellationToken cancellationToken = default)
    {
        var gate = locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        return new Releaser(gate);
    }
    private sealed class Releaser : IDisposable
    {
        private readonly SemaphoreSlim gate;
        private int released;
        public Releaser(SemaphoreSlim gate) => this.gate = gate;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref released, 1) == 0)
            {
                gate.Release();
            }
        }
    }
}

public sealed class InMemoryFeatureFlagSnapshot
{
    private readonly IFeatureFlags flags;
    public InMemoryFeatureFlagSnapshot(IFeatureFlags flags) => this.flags = flags;
    public IReadOnlyDictionary<string, bool> Capture(string tenantId, IEnumerable<string> names)
    {
        var captured = new Dictionary<string, bool>(StringComparer.Ordinal);
        foreach (var name in names)
        {
            if (name is null)
            {
                continue;
            }

            captured[name] = flags.Enabled(tenantId, name);
        }

        return captured;
    }
}

public sealed class CancellationAwareDispatcher : IWorkflowDispatcher
{
    private readonly IWorkflowDispatcher inner;
    public CancellationAwareDispatcher(IWorkflowDispatcher inner) => this.inner = inner;
    public Task<DeliveryResult> DispatchAsync(AssetEvent assetEvent, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return inner.DispatchAsync(assetEvent, cancellationToken);
    }
}
