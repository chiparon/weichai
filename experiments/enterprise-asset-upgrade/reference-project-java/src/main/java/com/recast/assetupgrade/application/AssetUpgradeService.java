package com.recast.assetupgrade.application;

import com.recast.assetupgrade.domain.AssetEvent;
import com.recast.assetupgrade.domain.AttachmentInput;
import com.recast.assetupgrade.domain.DeliveryResult;
import com.recast.assetupgrade.port.AttachmentQuarantine;
import com.recast.assetupgrade.port.AuditSink;
import com.recast.assetupgrade.port.Clock;
import com.recast.assetupgrade.port.IdempotencyStore;
import com.recast.assetupgrade.port.TenantAuthorizer;
import com.recast.assetupgrade.port.WorkflowDispatcher;
import com.recast.assetupgrade.policy.AttachmentPolicy;
import com.recast.assetupgrade.policy.EventPolicy;
import com.recast.assetupgrade.policy.TenantPolicy;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;

public final class AssetUpgradeService {
    private final TenantPolicy tenantPolicy;
    private final AttachmentPolicy attachmentPolicy;
    private final EventPolicy eventPolicy;
    private final IdempotencyStore idempotency;
    private final WorkflowDispatcher dispatcher;
    private final AuditCoordinator audit;
    private final Clock clock;

    public AssetUpgradeService(
            TenantAuthorizer authorizer,
            AttachmentQuarantine quarantine,
            WorkflowDispatcher dispatcher,
            IdempotencyStore idempotency,
            AuditSink audit,
            Clock clock) {
        this.tenantPolicy = new TenantPolicy(Objects.requireNonNull(authorizer));
        this.attachmentPolicy = new AttachmentPolicy(Objects.requireNonNull(quarantine));
        this.eventPolicy = new EventPolicy(Objects.requireNonNull(dispatcher));
        this.idempotency = Objects.requireNonNull(idempotency);
        this.dispatcher = dispatcher;
        this.audit = new AuditCoordinator(Objects.requireNonNull(audit));
        this.clock = Objects.requireNonNull(clock);
    }

    public CompletableFuture<DeliveryResult> submit(String actorId, AssetEvent event, AttachmentInput attachment) {
        String tenantError = tenantPolicy.validate(event.tenantId(), actorId, "asset.submit");
        if (tenantError != null) return rejected(event, tenantError);

        String eventError = eventPolicy.validate(event);
        if (eventError != null) return rejected(event, eventError);

        String attachmentError = validateAttachmentBinding(event, attachment);
        if (attachmentError != null) return rejected(event, attachmentError);

        AttachmentPolicy.Validation validation = attachmentPolicy.validate(attachment);
        if (!validation.valid()) {
            if (validation.quarantined()) {
                audit.quarantined(event.tenantId(), event.eventId(), "asset.submit", validation.reason(), clock.now());
                return CompletableFuture.completedFuture(DeliveryResult.quarantined(validation.reason()));
            }
            return rejected(event, validation.reason());
        }

        if (idempotency.hasCompleted(event.tenantId(), event.eventId())) {
            audit.duplicate(event.tenantId(), event.eventId(), "asset.submit", clock.now());
            return CompletableFuture.completedFuture(DeliveryResult.duplicate("event already completed"));
        }
        if (!idempotency.claim(event.tenantId(), event.eventId())) {
            audit.duplicate(event.tenantId(), event.eventId(), "asset.submit", clock.now());
            return CompletableFuture.completedFuture(DeliveryResult.duplicate("event is already being processed"));
        }

        return dispatcher.dispatch(event)
                .thenApply(result -> completeDispatch(event, result))
                .exceptionally(error -> recoverDispatch(event, error));
    }

    public boolean isAttachmentRequired(AssetEvent event) {
        return event.hasAttachment();
    }

    public String validateAttachmentBinding(AssetEvent event, AttachmentInput attachment) {
        if (event.hasAttachment() && attachment == null) return "attachment is required";
        if (attachment == null) return null;
        if (!event.tenantId().equals(attachment.tenantId())) return "attachment tenant mismatch";
        if (event.attachmentId() != null && !event.attachmentId().equals(attachment.attachmentId())) {
            return "attachment identity mismatch";
        }
        return null;
    }

    private DeliveryResult completeDispatch(AssetEvent event, DeliveryResult result) {
        if (result.accepted()) {
            idempotency.markCompleted(event.tenantId(), event.eventId());
            audit.accepted(event.tenantId(), event.eventId(), "asset.submit", clock.now());
        } else if (result.status() == com.recast.assetupgrade.domain.DeliveryStatus.RETRYABLE) {
            idempotency.release(event.tenantId(), event.eventId());
            audit.retryable(event.tenantId(), event.eventId(), "asset.submit", result.detail(), clock.now());
        } else {
            idempotency.release(event.tenantId(), event.eventId());
            audit.rejected(event.tenantId(), event.eventId(), "asset.submit", result.detail(), clock.now());
        }
        return result;
    }

    private DeliveryResult recoverDispatch(AssetEvent event, Throwable error) {
        idempotency.release(event.tenantId(), event.eventId());
        audit.retryable(event.tenantId(), event.eventId(), "asset.submit", rootMessage(error), clock.now());
        return DeliveryResult.retryable(rootMessage(error));
    }

    private CompletableFuture<DeliveryResult> rejected(AssetEvent event, String reason) {
        audit.rejected(event.tenantId(), event.eventId(), "asset.submit", reason, clock.now());
        return CompletableFuture.completedFuture(DeliveryResult.rejected(reason));
    }

    private String rootMessage(Throwable error) {
        Throwable current = error;
        while (current.getCause() != null) current = current.getCause();
        return current.getMessage() == null ? current.getClass().getSimpleName() : current.getMessage();
    }
}
