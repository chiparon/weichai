package com.recast.assetupgrade.port;

import com.recast.assetupgrade.domain.ValidationIssue;
import java.util.List;

public interface PolicyDecision {
    List<ValidationIssue> evaluate(String tenantId, String operation, String subjectId);
}
