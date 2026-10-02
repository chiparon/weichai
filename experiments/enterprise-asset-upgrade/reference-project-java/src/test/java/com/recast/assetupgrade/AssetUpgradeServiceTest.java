package com.recast.assetupgrade;

import com.recast.assetupgrade.domain.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class AssetUpgradeServiceTest {
    @Test void eventIsDispatchedAndMarkedCompleted() {
        var app = ReferenceApplication.create();
        var result = app.assetUpgrade.submit("operator", ReferenceFixtures.event("tenant-a", "evt-1"), null).join();
        assertTrue(result.accepted());
        assertEquals(DeliveryStatus.ACCEPTED, result.status());
        assertEquals(1, app.dispatcher.dispatchedCount());
        assertEquals(1, app.idempotency.completedCount());
    }

    @Test void duplicateEventReturnsDuplicateWithoutDispatchingAgain() {
        var app = ReferenceApplication.create();
        var event = ReferenceFixtures.event("tenant-a", "evt-2");
        assertEquals(DeliveryStatus.ACCEPTED, app.assetUpgrade.submit("operator", event, null).join().status());
        var duplicate = app.assetUpgrade.submit("operator", event, null).join();
        assertEquals(DeliveryStatus.DUPLICATE, duplicate.status());
        assertEquals(1, app.dispatcher.dispatchedCount());
    }

    @Test void inFlightDuplicateIsRejectedAsDuplicate() {
        var app = ReferenceApplication.create();
        var event = ReferenceFixtures.event("tenant-a", "evt-3");
        app.idempotency.claim("tenant-a", "evt-3");
        var duplicate = app.assetUpgrade.submit("operator", event, null).join();
        assertEquals(DeliveryStatus.DUPLICATE, duplicate.status());
        assertEquals(0, app.dispatcher.dispatchedCount());
    }

    @Test void unsupportedEventTypeIsRejected() {
        var app = ReferenceApplication.create();
        var event = new AssetEvent("evt-4", "tenant-a", "asset", "asset.deleted",
                app.clock.now(), null, WorkflowState.APPROVED);
        var result = app.assetUpgrade.submit("operator", event, null).join();
        assertEquals(DeliveryStatus.REJECTED, result.status());
        assertTrue(result.detail().contains("unsupported"));
    }

    @Test void eventRequiresAttachmentWhenAttachmentIdPresent() {
        var app = ReferenceApplication.create();
        var event = ReferenceFixtures.eventWithAttachment("tenant-a", "evt-5", "doc-5");
        var result = app.assetUpgrade.submit("operator", event, null).join();
        assertEquals(DeliveryStatus.REJECTED, result.status());
        assertTrue(result.detail().contains("attachment"));
    }

    @Test void attachmentTenantMismatchIsRejected() {
        var app = ReferenceApplication.create();
        var event = ReferenceFixtures.eventWithAttachment("tenant-a", "evt-6", "doc-6");
        var attachment = ReferenceFixtures.pdf("tenant-b", "doc-6");
        var result = app.assetUpgrade.submit("operator", event, attachment).join();
        assertEquals(DeliveryStatus.REJECTED, result.status());
        assertTrue(result.detail().contains("tenant"));
    }

    @Test void unscannedAttachmentIsQuarantined() {
        var app = ReferenceApplication.create();
        var event = ReferenceFixtures.eventWithAttachment("tenant-a", "evt-7", "doc-7");
        var result = app.assetUpgrade.submit("operator", event, ReferenceFixtures.text("tenant-a", "doc-7", AttachmentState.RECEIVED)).join();
        assertEquals(DeliveryStatus.QUARANTINED, result.status());
        assertEquals(0, app.dispatcher.dispatchedCount());
    }

    @Test void dispatcherRetryReleasesClaim() {
        var app = ReferenceApplication.create();
        app.dispatcher.failNext();
        var event = ReferenceFixtures.event("tenant-a", "evt-8");
        var result = app.assetUpgrade.submit("operator", event, null).join();
        assertEquals(DeliveryStatus.RETRYABLE, result.status());
        assertFalse(app.idempotency.hasCompleted("tenant-a", "evt-8"));
        assertEquals(DeliveryStatus.ACCEPTED, app.assetUpgrade.submit("operator", event, null).join().status());
    }
}
