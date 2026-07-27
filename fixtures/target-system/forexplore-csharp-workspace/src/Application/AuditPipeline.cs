using ForeXplore.Skeleton.Ports;

namespace ForeXplore.Skeleton.Application;

/// <summary>Coordinates durable audit appends and hash-chain verification.</summary>
public sealed class AuditPipeline
{
    private readonly IAuditJournal journal;

    /// <summary>Creates an audit pipeline backed by the supplied journal.</summary>
    public AuditPipeline(IAuditJournal journal)
    {
        this.journal = journal ?? throw new ArgumentNullException(nameof(journal));
    }

    // REQ: Sequence allocation and persistence are one observable operation to callers.
    /// <summary>Appends an audit entry and returns its durable sequence number.</summary>
    public ValueTask<long> AppendAsync(string action, string subject, string payload, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(action);
        ArgumentException.ThrowIfNullOrWhiteSpace(subject);
        ArgumentNullException.ThrowIfNull(payload);
        cancellationToken.ThrowIfCancellationRequested();

        return journal.AppendAsync(
            action.Trim(),
            subject.Trim(),
            payload,
            cancellationToken);
    }

    // REQ: Return false with diagnostics captured by the journal adapter when a link is broken.
    /// <summary>Verifies the integrity of the persisted audit chain.</summary>
    public Task<bool> VerifyAsync(CancellationToken cancellationToken) => journal.VerifyAsync(cancellationToken);
}
