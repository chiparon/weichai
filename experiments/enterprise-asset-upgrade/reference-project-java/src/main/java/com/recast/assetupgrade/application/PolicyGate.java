package com.recast.assetupgrade.application;

import com.recast.assetupgrade.domain.OperationContext;
import com.recast.assetupgrade.domain.ValidationIssue;
import com.recast.assetupgrade.port.PolicyDecision;
import java.util.ArrayList;
import java.util.List;

public final class PolicyGate {
    private final TenantBoundaryService tenant;
    private final PolicyDecision decisions;
    public PolicyGate(TenantBoundaryService tenant, PolicyDecision decisions) { this.tenant = tenant; this.decisions = decisions; }

    public List<ValidationIssue> evaluate(OperationContext context, String subjectId) {
        List<ValidationIssue> issues = new ArrayList<>(tenant.check(context));
        issues.addAll(decisions.evaluate(context.tenantId(), context.operation(), subjectId));
        return List.copyOf(issues);
    }

    public boolean allowed(OperationContext context, String subjectId) {
        return evaluate(context, subjectId).stream().noneMatch(ValidationIssue::blocksOperation);
    }
}
