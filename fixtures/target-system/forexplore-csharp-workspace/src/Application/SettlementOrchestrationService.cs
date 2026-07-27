using System.Collections.Concurrent;
using ForeXplore.Skeleton.Domain;
using ForeXplore.Skeleton.Ports;

namespace ForeXplore.Skeleton.Application;

/// <summary>Coordinates ordered and idempotent settlement batches.</summary>
public sealed class SettlementOrchestrationService
{
    private readonly IAuditJournal audit;
    private readonly ConcurrentDictionary<string, SettlementOutcome> completed =
        new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Task<SettlementOutcome>> inFlight =
        new(StringComparer.Ordinal);

    // REQ: The C# contract returns a typed outcome per instruction instead of Java's status record.
    /// <summary>Creates a settlement service backed by the supplied audit journal.</summary>
    public SettlementOrchestrationService(IAuditJournal audit)
    {
        this.audit = audit ?? throw new ArgumentNullException(nameof(audit));
    }

    // REQ: Preserve input order, deduplicate idempotency keys, and retry only transient gateway errors.
    /// <summary>Settles a batch while preserving order, idempotency, and retry semantics.</summary>
    public async Task<IReadOnlyList<SettlementOutcome>> SettleBatchAsync(
        IReadOnlyList<SettlementInstruction> instructions,
        Func<SettlementInstruction, int, CancellationToken, Task<SettlementOutcome>> gateway,
        CancellationToken cancellationToken)
    {
        // REQ: A failed item must not hide the outcome of later items in the same batch.
        ArgumentNullException.ThrowIfNull(instructions);
        ArgumentNullException.ThrowIfNull(gateway);

        var outcomes = new List<SettlementOutcome>(instructions.Count);
        foreach (var instruction in instructions)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (instruction is null)
            {
                outcomes.Add(new Rejected(string.Empty, "Settlement instruction cannot be null."));
                continue;
            }
            if (string.IsNullOrWhiteSpace(instruction.IdempotencyKey))
            {
                outcomes.Add(new Rejected(
                    instruction.IdempotencyKey ?? string.Empty,
                    "Idempotency key is required."));
                continue;
            }

            if (completed.TryGetValue(instruction.IdempotencyKey, out var prior))
            {
                outcomes.Add(prior);
                continue;
            }

            var execution = inFlight.GetOrAdd(
                instruction.IdempotencyKey,
                _ => ExecuteInstructionAsync(instruction, gateway, cancellationToken));
            SettlementOutcome outcome;
            try
            {
                outcome = await execution.WaitAsync(cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception error)
            {
                outcome = new Rejected(instruction.IdempotencyKey, error.Message);
            }
            finally
            {
                if (
                    inFlight.TryGetValue(instruction.IdempotencyKey, out var current) &&
                    ReferenceEquals(current, execution)
                )
                {
                    inFlight.TryRemove(instruction.IdempotencyKey, out _);
                }
            }

            if (outcome is Settled or Rejected)
            {
                completed.TryAdd(instruction.IdempotencyKey, outcome);
            }
            outcomes.Add(outcome);
        }

        return outcomes;
    }

    private async Task<SettlementOutcome> ExecuteInstructionAsync(
        SettlementInstruction instruction,
        Func<SettlementInstruction, int, CancellationToken, Task<SettlementOutcome>> gateway,
        CancellationToken cancellationToken)
    {
        var attempts = Math.Max(1, instruction.MaxAttempts);
        SettlementOutcome outcome =
            new RetryLater(instruction.IdempotencyKey, TimeSpan.Zero, "Not attempted.");

        for (var attempt = 1; attempt <= attempts; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                outcome = await gateway(instruction, attempt, cancellationToken)
                    ?? new Rejected(instruction.IdempotencyKey, "Gateway returned no outcome.");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (TimeoutException error)
            {
                outcome = new RetryLater(
                    instruction.IdempotencyKey,
                    RetryDelay(attempt),
                    error.Message);
            }
            catch (Exception error)
            {
                outcome = new Rejected(
                    instruction.IdempotencyKey,
                    $"{error.GetType().Name}: {error.Message}");
            }

            await audit.AppendAsync(
                "settlement.attempt",
                instruction.IdempotencyKey,
                $"{attempt}|{outcome.GetType().Name}",
                cancellationToken);

            if (outcome is not RetryLater retry || attempt == attempts)
            {
                return outcome;
            }
            if (retry.Delay > TimeSpan.Zero)
            {
                await Task.Delay(retry.Delay, cancellationToken);
            }
        }

        return outcome;
    }

    private static TimeSpan RetryDelay(int attempt) =>
        TimeSpan.FromMilliseconds(Math.Min(1_000, 25 * Math.Pow(2, attempt - 1)));
}
