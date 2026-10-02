package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.DeadLetterEvent;
import com.recast.assetupgrade.port.DeadLetterSink;
import java.util.ArrayList;
import java.util.List;

public final class InMemoryDeadLetterSink implements DeadLetterSink {
    private final List<DeadLetterEvent> events = new ArrayList<>();
    @Override public synchronized void publish(DeadLetterEvent event) { events.add(event); }
    @Override public synchronized List<DeadLetterEvent> findForTenant(String tenantId) {
        return events.stream().filter(item -> item.event().tenantId().equals(tenantId)).toList();
    }
    public synchronized List<DeadLetterEvent> all() { return List.copyOf(events); }
}
