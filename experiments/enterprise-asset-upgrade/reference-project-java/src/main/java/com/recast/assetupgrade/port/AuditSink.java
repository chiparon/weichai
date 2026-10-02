package com.recast.assetupgrade.port;

import com.recast.assetupgrade.domain.AuditRecord;
import java.util.List;

public interface AuditSink {
    void record(AuditRecord record);
    List<AuditRecord> recordsFor(String tenantId, String subjectId);
}
