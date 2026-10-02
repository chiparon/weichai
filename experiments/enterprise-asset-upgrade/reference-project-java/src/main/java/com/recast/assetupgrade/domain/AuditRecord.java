package com.recast.assetupgrade.domain;

import java.time.Instant;

public record AuditRecord(String tenantId, String subjectId, String action, String status, Instant at) {
    public AuditRecord {
        if (tenantId == null || tenantId.isBlank()) throw new IllegalArgumentException("tenantId is required");
        if (subjectId == null || subjectId.isBlank()) throw new IllegalArgumentException("subjectId is required");
        if (action == null || action.isBlank()) throw new IllegalArgumentException("action is required");
        if (status == null || status.isBlank()) throw new IllegalArgumentException("status is required");
        if (at == null) throw new NullPointerException("at");
    }
}
