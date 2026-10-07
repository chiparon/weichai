namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Adapters;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;

public sealed record AttachmentIntakeCommand(string TenantId, string ActorId, AttachmentInput Attachment, string CorrelationId);
public sealed record AttachmentIntakeResult(bool Accepted, AttachmentState State, IReadOnlyList<ValidationIssue> Issues, string? Fingerprint = null);

public sealed class AttachmentIntakeService
{
    private readonly ITenantAuthorizer authorizer;
    private readonly IAttachmentRepository repository;
    private readonly IAttachmentScanner scanner;
    private readonly IQuarantineLog quarantine;
    private readonly IAuditSink audit;
    private readonly IMetricsSink metrics;
    private readonly AttachmentValidationPipeline validation;
    private readonly IClock clock;

    public AttachmentIntakeService(ITenantAuthorizer authorizer, IAttachmentRepository repository, IAttachmentScanner scanner, IQuarantineLog quarantine, IAuditSink audit, IMetricsSink metrics, IClock? clock = null, AttachmentValidationPipeline? validation = null)
    {
        this.authorizer = authorizer; this.repository = repository; this.scanner = scanner; this.quarantine = quarantine; this.audit = audit; this.metrics = metrics; this.clock = clock ?? new SystemClock(); this.validation = validation ?? new AttachmentValidationPipeline();
    }

    public async Task<AttachmentIntakeResult> IntakeAsync(AttachmentIntakeCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        cancellationToken.ThrowIfCancellationRequested();

        var started = clock.UtcNow;
        var attachment = new RequestNormalizer().Normalize(command.Attachment);
        var normalized = command with { Attachment = attachment };

        if (!authorizer.CanAccess(normalized.TenantId, normalized.ActorId))
        {
            var forbidden = new ValidationIssue("attachment.tenant.forbidden", "Actor is not authorized for the attachment tenant.", ValidationSeverity.Error);
            return await Reject(normalized, forbidden, started, cancellationToken).ConfigureAwait(false);
        }

        var verdict = validation.Evaluate(attachment);
        if (!verdict.Allowed)
        {
            return await Reject(normalized, verdict.Issues, started, cancellationToken).ConfigureAwait(false);
        }

        var fingerprint = attachment.StableFingerprint();
        var existing = await repository.FindAsync(attachment.TenantId, attachment.AttachmentId, cancellationToken).ConfigureAwait(false);
        if (existing is not null && string.Equals(existing.StableFingerprint(), fingerprint, StringComparison.Ordinal))
        {
            audit.Record(new AuditRecord(normalized.TenantId, attachment.AttachmentId, "attachment.intake.duplicate", "duplicate", clock.UtcNow));
            return new AttachmentIntakeResult(true, AttachmentState.Scanned, Array.Empty<ValidationIssue>(), fingerprint);
        }

        var scan = await scanner.ScanAsync(attachment, cancellationToken).ConfigureAwait(false);
        if (!scan.Clean)
        {
            await repository.SaveAsync(attachment, cancellationToken).ConfigureAwait(false);
            var issues = new[] { new ValidationIssue("attachment.scan.pending", scan.Detail ?? "Attachment did not pass scanning.", ValidationSeverity.Warning) };
            await quarantine.RecordAsync(normalized.TenantId, attachment.AttachmentId, issues, cancellationToken).ConfigureAwait(false);
            metrics.Increment("attachment.rejected", normalized.TenantId);
            metrics.Timing("attachment.intake", normalized.TenantId, clock.UtcNow - started);
            audit.Record(new AuditRecord(normalized.TenantId, attachment.AttachmentId, "attachment.intake.quarantined", "quarantined", clock.UtcNow));
            return new AttachmentIntakeResult(false, AttachmentState.Quarantined, issues, fingerprint);
        }

        var scanned = attachment with { Scanned = true };
        await repository.SaveAsync(scanned, cancellationToken).ConfigureAwait(false);
        audit.Record(new AuditRecord(normalized.TenantId, attachment.AttachmentId, "attachment.intake.accepted", "accepted", clock.UtcNow));
        metrics.Increment("attachment.accepted", normalized.TenantId);
        metrics.Timing("attachment.intake", normalized.TenantId, clock.UtcNow - started);
        return new AttachmentIntakeResult(true, AttachmentState.Scanned, Array.Empty<ValidationIssue>(), fingerprint);
    }

    private Task<AttachmentIntakeResult> Reject(AttachmentIntakeCommand command, ValidationIssue issue, DateTimeOffset started, CancellationToken cancellationToken)
        => Reject(command, new[] { issue }, started, cancellationToken);

    private async Task<AttachmentIntakeResult> Reject(AttachmentIntakeCommand command, IReadOnlyList<ValidationIssue> issues, DateTimeOffset started, CancellationToken cancellationToken)
    {
        var materialized = issues is { Count: > 0 }
            ? issues
            : new[] { new ValidationIssue("attachment.rejected", "Attachment was rejected.", ValidationSeverity.Error) };

        await quarantine.RecordAsync(command.TenantId, command.Attachment.AttachmentId, materialized, cancellationToken).ConfigureAwait(false);
        metrics.Increment("attachment.rejected", command.TenantId);
        metrics.Timing("attachment.reject", command.TenantId, clock.UtcNow - started);
        audit.Record(new AuditRecord(command.TenantId, command.Attachment.AttachmentId, "attachment.intake.rejected", "quarantined", clock.UtcNow));
        return new AttachmentIntakeResult(false, AttachmentState.Quarantined, materialized, command.Attachment.StableFingerprint());
    }
}

public sealed class AttachmentQueryService
{
    private readonly IAttachmentRepository repository;
    private readonly ITenantAuthorizer authorizer;
    public AttachmentQueryService(IAttachmentRepository repository, ITenantAuthorizer authorizer) { this.repository = repository; this.authorizer = authorizer; }

    public async Task<AttachmentInput?> GetAsync(string tenantId, string actorId, string attachmentId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId))
        {
            return null;
        }

        return await repository.FindAsync(tenantId, attachmentId, cancellationToken).ConfigureAwait(false);
    }
}

public sealed class AttachmentReleaser
{
    private readonly IAttachmentRepository repository;
    private readonly ITenantAuthorizer authorizer;
    private readonly IAuditSink audit;
    public AttachmentReleaser(IAttachmentRepository repository, ITenantAuthorizer authorizer, IAuditSink audit) { this.repository = repository; this.authorizer = authorizer; this.audit = audit; }

    public async Task ReleaseAsync(string tenantId, string actorId, string attachmentId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId))
        {
            throw new UnauthorizedAccessException($"Actor '{actorId}' is not authorized for tenant '{tenantId}'.");
        }

        await repository.ReleaseAsync(tenantId, attachmentId, cancellationToken).ConfigureAwait(false);
        audit.Record(new AuditRecord(tenantId, attachmentId, "attachment.release", "released", DateTimeOffset.UtcNow));
    }
}
