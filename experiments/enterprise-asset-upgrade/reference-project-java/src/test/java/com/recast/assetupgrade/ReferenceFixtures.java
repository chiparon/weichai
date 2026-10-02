package com.recast.assetupgrade;

import com.recast.assetupgrade.domain.*;
import java.time.Instant;
import java.util.List;

final class ReferenceFixtures {
    private ReferenceFixtures() { }

    static AssetEvent event(String tenant, String id) {
        return new AssetEvent(id, tenant, "asset-" + id, "asset.created", Instant.parse("2026-01-01T00:00:00Z"), null, WorkflowState.APPROVED);
    }

    static AssetEvent eventWithAttachment(String tenant, String id, String attachmentId) {
        return new AssetEvent(id, tenant, "asset-" + id, "asset.updated", Instant.parse("2026-01-01T00:00:00Z"), attachmentId, WorkflowState.APPROVED);
    }

    static AttachmentInput pdf(String tenant, String id) {
        return new AttachmentInput(id, tenant, id + ".pdf", "application/pdf", "%PDF-1.7 sample".getBytes(), AttachmentState.SCANNED);
    }

    static AttachmentInput text(String tenant, String id, AttachmentState state) {
        return new AttachmentInput(id, tenant, id + ".txt", "text/plain", "text sample".getBytes(), state);
    }

    static OrderRequest order(String tenant, String id) {
        return new OrderRequest(id, tenant, tenant.equals("tenant-a") ? "operator" : "operator-b",
                List.of(new OrderLine("sku-1", 2, 1500), new OrderLine("sku-2", 1, 2000)), "CNY");
    }

    static PendingEvent pending(AssetEvent event, int attempts, Instant retryAfter) {
        return new PendingEvent(event.withState(WorkflowState.RETRY_PENDING), retryAfter, attempts, true);
    }
}
