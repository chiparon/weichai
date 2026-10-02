package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.ValidationIssue;
import com.recast.assetupgrade.port.PolicyDecision;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class InMemoryPolicyDecision implements PolicyDecision {
    private final Map<String, List<ValidationIssue>> decisions = new HashMap<>();
    public void set(String tenantId, String operation, String subjectId, List<ValidationIssue> issues) {
        decisions.put(key(tenantId, operation, subjectId), List.copyOf(issues));
    }
    public void clear() { decisions.clear(); }
    @Override public List<ValidationIssue> evaluate(String tenantId, String operation, String subjectId) {
        return decisions.getOrDefault(key(tenantId, operation, subjectId), List.of());
    }
    private String key(String tenantId, String operation, String subjectId) { return tenantId + "\u0000" + operation + "\u0000" + subjectId; }
}
