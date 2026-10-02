package com.recast.assetupgrade;

import com.recast.assetupgrade.domain.*;
import org.junit.jupiter.api.Test;
import java.time.Duration;
import static org.junit.jupiter.api.Assertions.*;

class ReconciliationServiceTest {
    @Test void dueEventIsRetriedAndRemovedAfterSuccess() {
        var app = ReferenceApplication.create();
        var event = ReferenceFixtures.event("tenant-a", "retry-1");
        app.retryStore.seed(ReferenceFixtures.pending(event, 0, app.clock.now()));
        var report = app.reconciliation.run("operator", app.clock.now(), 10).join();
        assertEquals(1, report.examined());
        assertEquals(1, report.retried());
        assertEquals(1, report.succeeded());
        assertTrue(app.retryStore.all().isEmpty());
    }

    @Test void futureEventIsNotExamined() {
        var app = ReferenceApplication.create();
        var event = ReferenceFixtures.event("tenant-a", "retry-2");
        app.retryStore.seed(ReferenceFixtures.pending(event, 0, app.clock.now().plus(Duration.ofHours(1))));
        var report = app.reconciliation.run("operator", app.clock.now(), 10).join();
        assertEquals(0, report.examined());
        assertEquals(1, app.retryStore.all().size());
    }

    @Test void actorFromAnotherTenantCannotProcessRetry() {
        var app = ReferenceApplication.create();
        var event = ReferenceFixtures.event("tenant-b", "retry-3");
        app.retryStore.seed(ReferenceFixtures.pending(event, 0, app.clock.now()));
        var report = app.reconciliation.run("operator", app.clock.now(), 10).join();
        assertEquals(1, report.examined());
        assertEquals(1, report.failed());
        assertEquals(0, app.dispatcher.dispatchedCount());
        assertEquals(1, app.retryStore.all().size());
    }

    @Test void retryableFailureIsRescheduledWithIncrementedAttempt() {
        var app = ReferenceApplication.create();
        app.dispatcher.failNext();
        var event = ReferenceFixtures.event("tenant-a", "retry-4");
        app.retryStore.seed(ReferenceFixtures.pending(event, 1, app.clock.now()));
        var report = app.reconciliation.run("operator", app.clock.now(), 10).join();
        assertEquals(1, report.failed());
        assertEquals(1, app.retryStore.all().size());
        assertEquals(2, app.retryStore.all().get(0).attempts());
        assertTrue(app.retryStore.all().get(0).retryAfter().isAfter(app.clock.now()));
    }

    @Test void completedEventInStoreIsRemovedWithoutDispatch() {
        var app = ReferenceApplication.create();
        var event = ReferenceFixtures.event("tenant-a", "retry-5");
        app.idempotency.markCompleted("tenant-a", "retry-5");
        app.retryStore.seed(ReferenceFixtures.pending(event, 1, app.clock.now()));
        var report = app.reconciliation.run("operator", app.clock.now(), 10).join();
        assertEquals(1, report.succeeded());
        assertEquals(0, app.dispatcher.dispatchedCount());
        assertTrue(app.retryStore.all().isEmpty());
    }

    @Test void retryLimitMovesEventToDeadLetter() {
        var app = ReferenceApplication.create();
        var event = ReferenceFixtures.event("tenant-a", "retry-6");
        app.retryStore.seed(ReferenceFixtures.pending(event, 4, app.clock.now()));
        var report = app.reconciliationOrchestrator.run("operator", app.clock.now(), 10).join();
        assertEquals(0, report.examined());
        assertEquals(1, app.deadLetters.all().size());
        assertEquals("tenant-a", app.deadLetters.all().get(0).event().tenantId());
        assertTrue(app.retryStore.all().isEmpty());
    }

    @Test void limitControlsBatchSize() {
        var app = ReferenceApplication.create();
        for (int i = 0; i < 5; i++) {
            app.retryStore.seed(ReferenceFixtures.pending(ReferenceFixtures.event("tenant-a", "retry-limit-" + i), 0, app.clock.now()));
        }
        var report = app.reconciliation.run("operator", app.clock.now(), 2).join();
        assertEquals(2, report.examined());
        assertEquals(2, report.succeeded());
        assertEquals(3, app.retryStore.all().size());
    }
}
