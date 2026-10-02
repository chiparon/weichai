package com.recast.assetupgrade;

import com.recast.assetupgrade.domain.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class WorkflowDeliveryCoordinatorTest {
    @Test void recordsSuccessfulAttemptAndMetrics() {
        var app = ReferenceApplication.create();
        var result = app.workflowDelivery.deliver(ReferenceFixtures.event("tenant-a", "hist-1"), 1).join();
        assertEquals(DeliveryStatus.ACCEPTED, result.status());
        assertEquals(1, app.dispatchHistory.find("tenant-a", "hist-1").size());
        assertEquals(1, app.metrics.counters("tenant-a").get("workflow.accepted"));
    }

    @Test void recordsTransportFailureAsRetryable() {
        var app = ReferenceApplication.create();
        app.dispatcher.failNext();
        var result = app.workflowDelivery.deliver(ReferenceFixtures.event("tenant-a", "hist-2"), 2).join();
        assertEquals(DeliveryStatus.RETRYABLE, result.status());
        var attempt = app.dispatchHistory.find("tenant-a", "hist-2").get(0);
        assertEquals(2, attempt.attempt());
        assertEquals(1, app.metrics.counters("tenant-a").get("workflow.retryable"));
    }

    @Test void unsupportedTypeIsRecordedWithoutCallingDispatcher() {
        var app = ReferenceApplication.create();
        var event = new AssetEvent("hist-3", "tenant-a", "asset", "unknown", app.clock.now(), null, WorkflowState.APPROVED);
        var result = app.workflowDelivery.deliver(event, 1).join();
        assertEquals(DeliveryStatus.REJECTED, result.status());
        assertEquals(1, app.dispatchHistory.find("tenant-a", "hist-3").size());
        assertEquals(0, app.dispatcher.dispatchedCount());
    }

    @Test void historySeparatesTenants() {
        var app = ReferenceApplication.create();
        app.workflowDelivery.deliver(ReferenceFixtures.event("tenant-a", "same-id"), 1).join();
        app.workflowDelivery.deliver(ReferenceFixtures.event("tenant-b", "same-id"), 1).join();
        assertEquals(1, app.dispatchHistory.find("tenant-a", "same-id").size());
        assertEquals(1, app.dispatchHistory.find("tenant-b", "same-id").size());
    }

    @Test void healthReportShowsFeatureState() {
        var app = ReferenceApplication.create();
        app.flags.enable("tenant-a", "workflow-retry");
        var report = app.health.check("tenant-a");
        assertTrue(report.healthy());
        assertEquals("up", report.status("clock"));
        assertEquals("enabled", report.status("workflow-retry"));
    }
}
