package com.recast.assetupgrade.application;

import com.recast.assetupgrade.domain.AuditRecord;
import com.recast.assetupgrade.port.AuditSink;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

public final class AuditQueryService {
    private final AuditSink sink;
    public AuditQueryService(AuditSink sink) { this.sink = sink; }

    public List<AuditRecord> subject(String tenantId, String subjectId) { return sink.recordsFor(tenantId, subjectId); }

    public List<AuditRecord> action(String tenantId, String action) {
        if (sink instanceof com.recast.assetupgrade.adapter.InMemoryAuditSink memory) {
            return memory.all().stream().filter(item -> item.tenantId().equals(tenantId) && item.action().equals(action)).toList();
        }
        return List.of();
    }

    public Map<String, Long> statusCounts(String tenantId, String subjectId) {
        return subject(tenantId, subjectId).stream().collect(java.util.stream.Collectors.groupingBy(AuditRecord::status, java.util.stream.Collectors.counting()));
    }

    public boolean hasAccepted(String tenantId, String subjectId) {
        return subject(tenantId, subjectId).stream().anyMatch(item -> item.status().equals("accepted"));
    }

    public List<AuditRecord> filter(String tenantId, Predicate<AuditRecord> predicate) {
        if (sink instanceof com.recast.assetupgrade.adapter.InMemoryAuditSink memory) {
            return memory.all().stream().filter(item -> item.tenantId().equals(tenantId)).filter(predicate).toList();
        }
        return List.of();
    }
}
