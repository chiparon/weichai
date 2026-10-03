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
        var started = clock.UtcNow;
        if (!authorizer.CanAccess(command.TenantId, command.ActorId))
            return Reject(command, new("tenant.access.denied", "Actor cannot access tenant.", ValidationSeverity.Error), started);
        var policy = validation.Evaluate(command.Attachment);
        if (!policy.Allowed)
        {
            await quarantine.RecordAsync(command.TenantId, command.Attachment.AttachmentId, policy.Issues, cancellationToken);
            audit.Record(new(command.TenantId, command.Attachment.AttachmentId, "attachment.quarantine", "rejected", clock.UtcNow));
            metrics.Increment("attachments.quarantined", command.TenantId);
            return new(false, AttachmentState.Quarantined, policy.Issues, command.Attachment.StableFingerprint());
        }
        var existing = await repository.FindAsync(command.TenantId, command.Attachment.AttachmentId, cancellationToken);
        if (existing is not null && existing.StableFingerprint() == command.Attachment.StableFingerprint())
        {
            metrics.Increment("attachments.duplicate", command.TenantId);
            return new(true, AttachmentState.Released, [new("attachment.duplicate", "The same attachment was already accepted.", ValidationSeverity.Info)], existing.StableFingerprint());
        }
        await repository.SaveAsync(command.Attachment, cancellationToken);
        var scan = await scanner.ScanAsync(command.Attachment, cancellationToken);
        if (!scan.Clean)
        {
            var issue = new ValidationIssue("attachment.scanner.rejected", scan.Detail ?? "Scanner rejected the attachment.", ValidationSeverity.Error);
            await quarantine.RecordAsync(command.TenantId, command.Attachment.AttachmentId, [issue], cancellationToken);
            metrics.Increment("attachments.scanner_rejected", command.TenantId);
            return new(false, AttachmentState.Rejected, [issue], command.Attachment.StableFingerprint());
        }
        await repository.ReleaseAsync(command.TenantId, command.Attachment.AttachmentId, cancellationToken);
        audit.Record(new(command.TenantId, command.Attachment.AttachmentId, "attachment.release", "accepted", clock.UtcNow));
        metrics.Increment("attachments.released", command.TenantId);
        metrics.Timing("attachments.intake.duration", command.TenantId, clock.UtcNow - started);
        return new(true, AttachmentState.Released, [], command.Attachment.StableFingerprint());
    }

    private AttachmentIntakeResult Reject(AttachmentIntakeCommand command, ValidationIssue issue, DateTimeOffset started)
    {
        metrics.Increment("attachments.authorization_rejected", command.TenantId);
        metrics.Timing("attachments.intake.duration", command.TenantId, clock.UtcNow - started);
        return new(false, AttachmentState.Rejected, [issue]);
    }
}

public sealed class AttachmentQueryService
{
    private readonly IAttachmentRepository repository;
    private readonly ITenantAuthorizer authorizer;
    public AttachmentQueryService(IAttachmentRepository repository, ITenantAuthorizer authorizer) { this.repository = repository; this.authorizer = authorizer; }
    public async Task<AttachmentInput?> GetAsync(string tenantId, string actorId, string attachmentId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId)) throw new UnauthorizedAccessException("Actor cannot access tenant.");
        return await repository.FindAsync(tenantId, attachmentId, cancellationToken);
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
        if (!authorizer.CanAccess(tenantId, actorId)) throw new UnauthorizedAccessException("Actor cannot access tenant.");
        var attachment = await repository.FindAsync(tenantId, attachmentId, cancellationToken) ?? throw new KeyNotFoundException("Attachment was not found.");
        if (!attachment.Scanned) throw new InvalidOperationException("Attachment must be scanned before release.");
        await repository.ReleaseAsync(tenantId, attachmentId, cancellationToken);
        audit.Record(new(tenantId, attachmentId, "attachment.release.manual", "accepted", DateTimeOffset.UtcNow));
    }
}
