package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.AuditRecord;
import com.recast.assetupgrade.port.AuditSink;
import java.util.ArrayList;
import java.util.List;

public final class InMemoryAuditSink implements AuditSink {
    private final List<AuditRecord> records = new ArrayList<>();
    @Override public synchronized void record(AuditRecord record) { records.add(record); }
    @Override public synchronized List<AuditRecord> recordsFor(String tenantId, String subjectId) {
        return records.stream().filter(item -> item.tenantId().equals(tenantId) && item.subjectId().equals(subjectId)).toList();
    }
    public synchronized List<AuditRecord> all() { return List.copyOf(records); }
}
