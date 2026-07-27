using ForeXplore.Skeleton.Domain;
using ForeXplore.Skeleton.Ports;

namespace ForeXplore.Skeleton.Application;

/// <summary>Coordinates quote caching, provider fallback, and audit recording.</summary>
public sealed class QuoteOrchestrationService
{
    private readonly IReadOnlyList<IQuoteProvider> providers;
    private readonly IQuoteCache cache;
    private readonly IAuditJournal audit;

    // REQ: Dependencies are injected so tests can model time, provider faults, and persistence failures.
    /// <summary>Creates a quote service with its providers, cache, and audit journal.</summary>
    public QuoteOrchestrationService(IReadOnlyList<IQuoteProvider> providers, IQuoteCache cache, IAuditJournal audit)
    {
        ArgumentNullException.ThrowIfNull(providers);
        this.providers = providers.ToArray();
        this.cache = cache ?? throw new ArgumentNullException(nameof(cache));
        this.audit = audit ?? throw new ArgumentNullException(nameof(audit));
    }

    // REQ: Normalize pair once, cache by normalized pair, and preserve request cancellation semantics.
    /// <summary>Gets a quote through the configured cache and provider fallback policy.</summary>
    public async Task<Quote> GetQuoteAsync(QuoteRequest request, CancellationToken cancellationToken)
    {
        // REQ: Java uses a synchronous loader; the C# port must keep the async boundary visible.
        // TODO(forexplore): translate the selected Java cache workflow into this async boundary.
        throw new NotImplementedException("Translation exercise: implement cache and fallback orchestration");
    }

    // REQ: Providers are attempted in policy order and every failure is appended to the audit journal.
    /// <summary>Queries eligible providers in policy order until one returns a quote.</summary>
    private async Task<Quote> FetchWithFallbackAsync(QuoteRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        var pair = NormalizePair(request);
        var failures = new List<Exception>();
        foreach (var provider in providers)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                if (!provider.Supports(pair))
                {
                    continue;
                }

                var quote = await provider.FetchAsync(request, cancellationToken);
                ValidateQuote(quote, pair);
                await audit.AppendAsync(
                    "quote.provider.selected",
                    pair,
                    provider.Name,
                    cancellationToken);
                return quote;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception error)
            {
                failures.Add(error);
                await audit.AppendAsync(
                    "quote.provider.failed",
                    pair,
                    $"{provider.Name}|{error.GetType().Name}|{error.Message}",
                    cancellationToken);
            }
        }

        if (failures.Count == 0)
        {
            throw new InvalidOperationException($"No quote provider supports {pair}.");
        }

        throw new AggregateException(
            $"All eligible quote providers failed for {pair}.",
            failures);
    }

    private static string NormalizePair(QuoteRequest request)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Base);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Counter);
        return $"{request.Base.Trim()}{request.Counter.Trim()}".ToUpperInvariant();
    }

    private static void ValidateQuote(Quote quote, string expectedPair)
    {
        ArgumentNullException.ThrowIfNull(quote);
        if (!string.Equals(quote.Pair, expectedPair, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException(
                $"Provider {quote.Provider} returned {quote.Pair} for {expectedPair}.");
        }
        if (quote.Bid.Amount > quote.Ask.Amount)
        {
            throw new InvalidDataException(
                $"Provider {quote.Provider} returned a bid above its ask.");
        }
    }
}
