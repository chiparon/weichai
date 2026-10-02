package com.recast.assetupgrade.port;

import com.recast.assetupgrade.domain.PendingEvent;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CompletableFuture;

public interface RetryableEventStore {
    CompletableFuture<List<PendingEvent>> findDue(Instant now, int limit);
    CompletableFuture<Void> save(PendingEvent event);
    CompletableFuture<Void> remove(String tenantId, String eventId);
}
