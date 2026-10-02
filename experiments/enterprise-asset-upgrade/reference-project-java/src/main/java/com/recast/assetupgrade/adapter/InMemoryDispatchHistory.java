package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.DispatchAttempt;
import com.recast.assetupgrade.port.DispatchHistory;
import java.util.ArrayList;
import java.util.List;

public final class InMemoryDispatchHistory implements DispatchHistory {
    private final List<DispatchAttempt> attempts = new ArrayList<>();
    @Override public synchronized void append(DispatchAttempt attempt) { attempts.add(attempt); }
    @Override public synchronized List<DispatchAttempt> find(String tenantId, String eventId) {
        return attempts.stream().filter(item -> item.tenantId().equals(tenantId) && item.eventId().equals(eventId)).toList();
    }
    public synchronized List<DispatchAttempt> all() { return List.copyOf(attempts); }
}
