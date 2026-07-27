using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using ForeXplore.Skeleton.Domain;
using ForeXplore.Skeleton.Ports;

namespace ForeXplore.Skeleton.Infrastructure;

// REQ: Test adapter records calls and can be configured to fail a fixed number of times.
/// <summary>Provides deterministic in-memory quote responses for tests.</summary>
public sealed class InMemoryQuoteProvider : IQuoteProvider
{
    private readonly int failuresBeforeSuccess;
    private int calls;

    // REQ: Name participates in deterministic routing and audit output.
    public string Name { get; }

    /// <summary>Creates a deterministic provider that can simulate transient failures.</summary>
    public InMemoryQuoteProvider(string name, int failuresBeforeSuccess)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        Name = name.Trim();
        this.failuresBeforeSuccess = Math.Max(0, failuresBeforeSuccess);
    }

    // REQ: Capability data is immutable for the lifetime of the adapter.
    /// <summary>Reports whether this provider supports the requested currency pair.</summary>
    public bool Supports(string pair) =>
        NormalizePair(pair) is "EURUSD" or "GBPUSD" or "USDJPY";

    // REQ: Simulate latency and transient errors without blocking a thread.
    /// <summary>Fetches a deterministic quote or raises a configured transient failure.</summary>
    public async ValueTask<Quote> FetchAsync(QuoteRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var pair = NormalizePair($"{request.Base}{request.Counter}");
        if (!Supports(pair))
        {
            throw new ArgumentException(
                $"Provider {Name} does not support {pair}.",
                nameof(request));
        }

        var attempt = Interlocked.Increment(ref calls);
        var latency = 8 + attempt % 4;
        await Task.Delay(latency, cancellationToken);
        if (attempt <= failuresBeforeSuccess)
        {
            throw new TimeoutException(
                $"Provider {Name} simulated transient failure {attempt}.");
        }

        var (bid, ask) = pair switch
        {
            "EURUSD" => (1.0848m, 1.0852m),
            "GBPUSD" => (1.2712m, 1.2718m),
            "USDJPY" => (154.18m, 154.24m),
            _ => throw new InvalidOperationException($"No deterministic rate for {pair}."),
        };
        var counterCurrency = request.Counter.Trim().ToUpperInvariant();
        return new Quote(
            Name,
            pair,
            new Money(counterCurrency, bid),
            new Money(counterCurrency, ask),
            request.RequestedAt.AddMilliseconds(latency),
            latency);
    }

    private static string NormalizePair(string pair)
    {
        if (string.IsNullOrWhiteSpace(pair)) return string.Empty;
        return string.Concat(pair.Where(char.IsLetterOrDigit)).ToUpperInvariant();
    }
}

// REQ: Concurrent callers must observe one logical value per normalized pair.
/// <summary>Stores quotes in memory behind the target cache contract.</summary>
public sealed class InMemoryQuoteCache : IQuoteCache
{
    private sealed record CacheEntry(Quote Quote, DateTimeOffset ExpiresAt);

    private readonly ConcurrentDictionary<string, CacheEntry> values =
        new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Lazy<Task<Quote>>> loads =
        new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, long> versions =
        new(StringComparer.Ordinal);
    private readonly TimeProvider clock;

    /// <summary>Creates a cache using the supplied clock or the system clock.</summary>
    public InMemoryQuoteCache(TimeProvider? clock = null)
    {
        this.clock = clock ?? TimeProvider.System;
    }

    /// <summary>Returns a cached quote or loads and stores a new value.</summary>
    public async Task<Quote> GetOrLoadAsync(
        QuoteRequest request,
        Func<CancellationToken, Task<Quote>> loader,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(loader);
        cancellationToken.ThrowIfCancellationRequested();

        var key = NormalizePair(request);
        var now = clock.GetUtcNow();
        if (values.TryGetValue(key, out var existing) && existing.ExpiresAt > now)
        {
            return existing.Quote;
        }

        var version = versions.GetOrAdd(key, 0);
        var candidate = new Lazy<Task<Quote>>(
            () => LoadAndStoreAsync(key, request.MaxAge, version, loader),
            LazyThreadSafetyMode.ExecutionAndPublication);
        var active = loads.GetOrAdd(key, candidate);
        var task = active.Value;
        try
        {
            return await task.WaitAsync(cancellationToken);
        }
        finally
        {
            if (
                task.IsCompleted &&
                loads.TryGetValue(key, out var current) &&
                ReferenceEquals(current, active)
            )
            {
                loads.TryRemove(key, out _);
            }
        }
    }

    /// <summary>Removes the normalized currency pair from the cache.</summary>
    public void Invalidate(string pair)
    {
        var key = NormalizePair(pair);
        versions.AddOrUpdate(key, 1, (_, value) => unchecked(value + 1));
        values.TryRemove(key, out _);
        loads.TryRemove(key, out _);
    }

    private async Task<Quote> LoadAndStoreAsync(
        string key,
        TimeSpan maxAge,
        long version,
        Func<CancellationToken, Task<Quote>> loader)
    {
        var loaded = await loader(CancellationToken.None);
        ArgumentNullException.ThrowIfNull(loaded);
        if (versions.GetOrAdd(key, 0) == version)
        {
            var effectiveMaxAge = maxAge > TimeSpan.Zero ? maxAge : TimeSpan.Zero;
            values[key] = new CacheEntry(loaded, clock.GetUtcNow().Add(effectiveMaxAge));
        }
        return loaded;
    }

    private static string NormalizePair(QuoteRequest request)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Base);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Counter);
        return NormalizePair($"{request.Base}{request.Counter}");
    }

    private static string NormalizePair(string pair)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pair);
        return string.Concat(pair.Where(char.IsLetterOrDigit)).ToUpperInvariant();
    }
}

// REQ: Hash canonicalization is stable across machines and uses UTF-8 bytes.
/// <summary>Stores an append-only, verifiable audit hash chain in memory.</summary>
public sealed class InMemoryAuditJournal : IAuditJournal
{
    private sealed record AuditEntry(
        long Sequence,
        string Action,
        string Subject,
        string Payload,
        string PreviousHash,
        string Hash);

    private static readonly string GenesisHash = new('0', 64);
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly List<AuditEntry> entries = new();

    /// <summary>Appends one entry after its predecessor and returns the new sequence.</summary>
    public async ValueTask<long> AppendAsync(
        string action,
        string subject,
        string payload,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(action);
        ArgumentException.ThrowIfNullOrWhiteSpace(subject);
        ArgumentNullException.ThrowIfNull(payload);

        await gate.WaitAsync(cancellationToken);
        try
        {
            var sequence = entries.Count + 1L;
            var previousHash = entries.Count == 0 ? GenesisHash : entries[^1].Hash;
            var hash = Digest(Canonical(
                sequence,
                action,
                subject,
                payload,
                previousHash));
            entries.Add(new AuditEntry(
                sequence,
                action,
                subject,
                payload,
                previousHash,
                hash));
            return sequence;
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>Verifies sequence continuity, links, and every stored digest.</summary>
    public async Task<bool> VerifyAsync(CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var previousHash = GenesisHash;
            for (var index = 0; index < entries.Count; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var entry = entries[index];
                var expected = Digest(Canonical(
                    index + 1L,
                    entry.Action,
                    entry.Subject,
                    entry.Payload,
                    previousHash));
                if (
                    entry.Sequence != index + 1L ||
                    !HashEquals(entry.PreviousHash, previousHash) ||
                    !HashEquals(entry.Hash, expected)
                )
                {
                    return false;
                }
                previousHash = entry.Hash;
            }
            return true;
        }
        finally
        {
            gate.Release();
        }
    }

    private static string Canonical(
        long sequence,
        string action,
        string subject,
        string payload,
        string previousHash) =>
        string.Join(
            '\n',
            sequence.ToString(CultureInfo.InvariantCulture),
            previousHash,
            Encode(action),
            Encode(subject),
            Encode(payload));

    private static string Encode(string value) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(value));

    private static string Digest(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))
            .ToLowerInvariant();

    private static bool HashEquals(string left, string right) =>
        CryptographicOperations.FixedTimeEquals(
            Convert.FromHexString(left),
            Convert.FromHexString(right));
}
