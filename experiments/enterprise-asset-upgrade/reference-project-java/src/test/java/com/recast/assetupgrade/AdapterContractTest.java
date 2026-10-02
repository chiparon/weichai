package com.recast.assetupgrade;

import com.recast.assetupgrade.domain.*;
import org.junit.jupiter.api.Test;
import java.time.Instant;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class AdapterContractTest {
    @Test void attachmentRepositoryIsTenantScoped() {
        var repository = new com.recast.assetupgrade.adapter.InMemoryAttachmentRepository();
        repository.save(ReferenceFixtures.pdf("tenant-a", "same"));
        assertTrue(repository.find("tenant-a", "same").isPresent());
        assertTrue(repository.find("tenant-b", "same").isEmpty());
    }

    @Test void idempotencyStoreSeparatesTenants() {
        var store = new com.recast.assetupgrade.adapter.InMemoryIdempotencyStore();
        store.markCompleted("tenant-a", "operation");
        assertTrue(store.hasCompleted("tenant-a", "operation"));
        assertFalse(store.hasCompleted("tenant-b", "operation"));
        assertTrue(store.claim("tenant-b", "operation"));
    }

    @Test void retryStoreReplacesSameEventInsteadOfDuplicating() {
        var store = new com.recast.assetupgrade.adapter.InMemoryRetryableEventStore();
        var event = ReferenceFixtures.event("tenant-a", "same");
        store.seed(ReferenceFixtures.pending(event, 0, Instant.EPOCH));
        store.seed(ReferenceFixtures.pending(event, 1, Instant.EPOCH.plusSeconds(10)));
        assertEquals(1, store.all().size());
        assertEquals(1, store.all().get(0).attempts());
    }

    @Test void transactionBoundaryCountsFailures() {
        var boundary = new com.recast.assetupgrade.adapter.InMemoryTransactionBoundary();
        assertEquals("ok", boundary.execute(() -> java.util.concurrent.CompletableFuture.completedFuture("ok")).join());
        assertThrows(RuntimeException.class, () -> boundary.execute(() -> java.util.concurrent.CompletableFuture.failedFuture(new IllegalStateException("boom"))).join());
        assertEquals(2, boundary.transactionCount());
        assertEquals(1, boundary.failureCount());
    }

    @Test void auditSinkFiltersByTenantAndSubject() {
        var sink = new com.recast.assetupgrade.adapter.InMemoryAuditSink();
        var at = Instant.EPOCH;
        sink.record(new AuditRecord("tenant-a", "subject", "action", "ok", at));
        sink.record(new AuditRecord("tenant-b", "subject", "action", "ok", at));
        sink.record(new AuditRecord("tenant-a", "other", "action", "ok", at));
        assertEquals(1, sink.recordsFor("tenant-a", "subject").size());
        assertEquals(3, sink.all().size());
    }

    @Test void featureFlagsAreTenantScoped() {
        var flags = new com.recast.assetupgrade.adapter.InMemoryFeatureFlags();
        flags.enable("tenant-a", "new-policy");
        assertTrue(flags.enabled("tenant-a", "new-policy"));
        assertFalse(flags.enabled("tenant-b", "new-policy"));
        flags.disable("tenant-a", "new-policy");
        assertFalse(flags.enabled("tenant-a", "new-policy"));
    }
}
