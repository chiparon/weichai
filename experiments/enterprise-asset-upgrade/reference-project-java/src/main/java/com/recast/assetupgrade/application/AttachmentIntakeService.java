package com.recast.assetupgrade.application;

import com.recast.assetupgrade.domain.AttachmentInput;
import com.recast.assetupgrade.domain.AttachmentScanResult;
import com.recast.assetupgrade.domain.AttachmentState;
import com.recast.assetupgrade.domain.ValidationIssue;
import com.recast.assetupgrade.port.AttachmentRepository;
import com.recast.assetupgrade.port.AttachmentScanner;
import com.recast.assetupgrade.port.AuditSink;
import com.recast.assetupgrade.port.Clock;
import com.recast.assetupgrade.port.TenantAuthorizer;
import com.recast.assetupgrade.policy.AttachmentValidationPolicy;
import com.recast.assetupgrade.policy.TenantPolicy;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/** Validates, scans, and persists an attachment before a workflow event can reference it. */
public final class AttachmentIntakeService {
    private final TenantPolicy tenantPolicy;
    private final AttachmentValidationPolicy validation;
    private final AttachmentRepository repository;
    private final AttachmentScanner scanner;
    private final AuditCoordinator audit;
    private final Clock clock;

    public AttachmentIntakeService(TenantAuthorizer authorizer, AttachmentValidationPolicy validation,
                                   AttachmentRepository repository, AttachmentScanner scanner,
                                   AuditSink audit, Clock clock) {
        this.tenantPolicy = new TenantPolicy(authorizer);
        this.validation = validation;
        this.repository = repository;
        this.scanner = scanner;
        this.audit = new AuditCoordinator(audit);
        this.clock = clock;
    }

    public CompletableFuture<AttachmentInput> accept(String actorId, AttachmentInput input) {
        String access = tenantPolicy.validate(input.tenantId(), actorId, "asset.attachment");
        if (access != null) return CompletableFuture.failedFuture(new IllegalArgumentException(access));
        List<ValidationIssue> issues = validation.evaluate(input);
        if (issues.stream().anyMatch(ValidationIssue::blocksOperation)) {
            audit.rejected(input.tenantId(), input.attachmentId(), "attachment.accept", summarize(issues), clock.now());
            return CompletableFuture.failedFuture(new IllegalArgumentException(summarize(issues)));
        }
        AttachmentInput quarantined = withState(input, AttachmentState.QUARANTINED);
        repository.save(quarantined);
        return scanner.scan(quarantined).thenCompose(result -> completeScan(quarantined, result));
    }

    public java.util.Optional<AttachmentInput> find(String tenantId, String attachmentId) {
        return repository.find(tenantId, attachmentId);
    }

    private CompletableFuture<AttachmentInput> completeScan(AttachmentInput input, AttachmentScanResult result) {
        if (!result.allowed()) {
            AttachmentInput rejected = withState(input, AttachmentState.REJECTED);
            repository.save(rejected);
            audit.rejected(input.tenantId(), input.attachmentId(), "attachment.scan", result.detail(), clock.now());
            return CompletableFuture.failedFuture(new IllegalStateException(result.detail()));
        }
        AttachmentInput released = withState(input, AttachmentState.SCANNED);
        repository.save(released);
        audit.accepted(input.tenantId(), input.attachmentId(), "attachment.scan", clock.now());
        return CompletableFuture.completedFuture(released);
    }

    private AttachmentInput withState(AttachmentInput input, AttachmentState state) {
        return new AttachmentInput(input.attachmentId(), input.tenantId(), input.fileName(), input.declaredContentType(), input.content(), state);
    }

    private String summarize(List<ValidationIssue> issues) {
        return issues.stream().map(item -> item.code() + ":" + item.message()).reduce((a, b) -> a + "; " + b).orElse("invalid attachment");
    }
}
