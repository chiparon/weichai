package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.PendingEvent;
import com.recast.assetupgrade.port.RetryableEventStore;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CompletableFuture;

public final class InMemoryRetryableEventStore implements RetryableEventStore {
    private final List<PendingEvent> events = new ArrayList<>();

    public synchronized void seed(PendingEvent event) { saveInternal(event); }

    @Override public synchronized CompletableFuture<List<PendingEvent>> findDue(Instant now, int limit) {
        return CompletableFuture.completedFuture(events.stream()
                .filter(item -> item.retryable() && !item.retryAfter().isAfter(now))
                .sorted(Comparator.comparing(PendingEvent::retryAfter))
                .limit(limit)
                .toList());
    }

    @Override public synchronized CompletableFuture<Void> save(PendingEvent event) {
        saveInternal(event);
        return CompletableFuture.completedFuture(null);
    }

    @Override public synchronized CompletableFuture<Void> remove(String tenantId, String eventId) {
        events.removeIf(item -> item.event().tenantId().equals(tenantId) && item.event().eventId().equals(eventId));
        return CompletableFuture.completedFuture(null);
    }

    public synchronized List<PendingEvent> all() { return List.copyOf(events); }

    private void saveInternal(PendingEvent event) {
        events.removeIf(item -> item.event().tenantId().equals(event.event().tenantId()) && item.event().eventId().equals(event.event().eventId()));
        events.add(event);
    }
}
