using ForeXplore.Skeleton.Application;
using ForeXplore.Skeleton.Domain;
using ForeXplore.Skeleton.Infrastructure;
using ForeXplore.Skeleton.Ports;

namespace ForeXplore.Skeleton;

/// <summary>Hosts the ForeXplore C# translation target.</summary>
public static class Program
{
    // REQ: The sample host wires ports explicitly and must never create global mutable state.
    /// <summary>Composes the sample host and runs the translation exercise.</summary>
    public static async Task Main(string[] args)
    {
        // REQ: Keep this entry point executable once the translation exercise is completed.
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var journal = new InMemoryAuditJournal();
        var auditPipeline = new AuditPipeline(journal);
        var providers = new IQuoteProvider[]
        {
            new InMemoryQuoteProvider("northstar", failuresBeforeSuccess: 1),
            new InMemoryQuoteProvider("harbor", failuresBeforeSuccess: 0),
        };
        var quoteService = new QuoteOrchestrationService(
            providers,
            new InMemoryQuoteCache(),
            journal);
        var settlementService = new SettlementOrchestrationService(journal);

        await auditPipeline.AppendAsync(
            "host.started",
            nameof(Program),
            "ForeXplore sample host initialized.",
            cancellation.Token);

        var instructions = new[]
        {
            new SettlementInstruction(
                "sample-001",
                "EURUSD",
                new Money("EUR", 1_200.50m),
                "ledger-demo",
                MaxAttempts: 2),
        };
        var outcomes = await settlementService.SettleBatchAsync(
            instructions,
            static (instruction, attempt, _) =>
                Task.FromResult<SettlementOutcome>(
                    attempt == 1
                        ? new RetryLater(
                            instruction.IdempotencyKey,
                            TimeSpan.Zero,
                            "Simulated transient response.")
                        : new Settled(
                            instruction.IdempotencyKey,
                            $"{instruction.IdempotencyKey}-receipt",
                            DateTimeOffset.UtcNow)),
            cancellation.Token);

        if (args.Contains("--quote", StringComparer.OrdinalIgnoreCase))
        {
            var request = new QuoteRequest(
                "EUR",
                "USD",
                DateTimeOffset.UtcNow,
                TimeSpan.FromSeconds(30));
            var quote = await quoteService.GetQuoteAsync(request, cancellation.Token);
            Console.WriteLine(
                $"quote={quote.Pair} {quote.Bid.Amount}/{quote.Ask.Amount} via {quote.Provider}");
        }
        else
        {
            Console.WriteLine(
                "Quote workflow is the remaining translation target; run with --quote after backfill.");
        }

        Console.WriteLine(
            $"settlements={outcomes.Count}, auditValid={await auditPipeline.VerifyAsync(cancellation.Token)}");
    }
}
