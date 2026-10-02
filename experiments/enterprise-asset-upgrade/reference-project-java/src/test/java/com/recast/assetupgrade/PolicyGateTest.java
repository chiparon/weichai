package com.recast.assetupgrade;

import com.recast.assetupgrade.adapter.InMemoryPolicyDecision;
import com.recast.assetupgrade.application.PolicyGate;
import com.recast.assetupgrade.application.TenantBoundaryService;
import com.recast.assetupgrade.domain.OperationContext;
import com.recast.assetupgrade.domain.ValidationIssue;
import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class PolicyGateTest {
    @Test void combinesTenantAndSubjectPolicies() {
        var app = ReferenceApplication.create();
        var decisions = new InMemoryPolicyDecision();
        var gate = new PolicyGate(new TenantBoundaryService(app.authorizer), decisions);
        var context = new OperationContext("tenant-a", "operator", "asset.submit", "corr", java.util.Map.of());
        assertTrue(gate.allowed(context, "evt"));
        decisions.set("tenant-a", "asset.submit", "evt", List.of(ValidationIssue.error("maintenance", "workflow disabled")));
        assertFalse(gate.allowed(context, "evt"));
        assertEquals("maintenance", gate.evaluate(context, "evt").get(0).code());
    }

    @Test void unauthorizedContextIsBlockedEvenWithoutSubjectDecision() {
        var app = ReferenceApplication.create();
        var gate = new PolicyGate(new TenantBoundaryService(app.authorizer), new InMemoryPolicyDecision());
        var context = new OperationContext("tenant-a", "unknown", "asset.submit", "corr", java.util.Map.of());
        assertFalse(gate.allowed(context, "evt"));
        assertEquals("authorization", gate.evaluate(context, "evt").get(0).code());
    }

    @Test void warningDoesNotBlockOperation() {
        var app = ReferenceApplication.create();
        var decisions = new InMemoryPolicyDecision();
        decisions.set("tenant-a", "asset.submit", "evt", List.of(ValidationIssue.warning("degraded", "fallback enabled")));
        var gate = new PolicyGate(new TenantBoundaryService(app.authorizer), decisions);
        var context = new OperationContext("tenant-a", "operator", "asset.submit", "corr", java.util.Map.of());
        assertTrue(gate.allowed(context, "evt"));
    }

    @Test void clearingDecisionRestoresTenantOnlyPolicy() {
        var app = ReferenceApplication.create();
        var decisions = new InMemoryPolicyDecision();
        var gate = new PolicyGate(new TenantBoundaryService(app.authorizer), decisions);
        var context = new OperationContext("tenant-a", "operator", "asset.submit", "corr", java.util.Map.of());
        decisions.set("tenant-a", "asset.submit", "evt", List.of(ValidationIssue.error("blocked", "temporary block")));
        assertFalse(gate.allowed(context, "evt"));
        decisions.clear();
        assertTrue(gate.allowed(context, "evt"));
    }

    @Test void missingSubjectDecisionIsRepresentedAsAnEmptyList() {
        var decisions = new InMemoryPolicyDecision();
        assertTrue(decisions.evaluate("tenant-a", "asset.submit", "missing").isEmpty());
    }

    @Test void policyResultRemainsTenantScopedAfterAnotherTenantIsConfigured() {
        var app = ReferenceApplication.create();
        var decisions = new InMemoryPolicyDecision();
        decisions.set("tenant-b", "asset.submit", "evt", List.of(ValidationIssue.error("blocked", "tenant-specific")));
        var gate = new PolicyGate(new TenantBoundaryService(app.authorizer), decisions);
        var context = new OperationContext("tenant-a", "operator", "asset.submit", "corr", java.util.Map.of());
        assertTrue(gate.allowed(context, "evt"));
    }
}
