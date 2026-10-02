package com.recast.assetupgrade.application;

import com.recast.assetupgrade.domain.AuditRecord;
import com.recast.assetupgrade.port.AuditSink;
import java.time.Instant;

public final class AuditCoordinator {
    private final AuditSink sink;

    public AuditCoordinator(AuditSink sink) {
        this.sink = sink;
    }

    public void accepted(String tenantId, String subjectId, String action, Instant at) {
        sink.record(new AuditRecord(tenantId, subjectId, action, "accepted", at));
    }

    public void rejected(String tenantId, String subjectId, String action, String reason, Instant at) {
        sink.record(new AuditRecord(tenantId, subjectId, action, "rejected:" + reason, at));
    }

    public void retryable(String tenantId, String subjectId, String action, String reason, Instant at) {
        sink.record(new AuditRecord(tenantId, subjectId, action, "retryable:" + reason, at));
    }

    public void duplicate(String tenantId, String subjectId, String action, Instant at) {
        sink.record(new AuditRecord(tenantId, subjectId, action, "duplicate", at));
    }

    public void quarantined(String tenantId, String subjectId, String action, String reason, Instant at) {
        sink.record(new AuditRecord(tenantId, subjectId, action, "quarantined:" + reason, at));
    }
}
