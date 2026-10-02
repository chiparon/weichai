package com.recast.assetupgrade;

import com.recast.assetupgrade.domain.*;
import com.recast.assetupgrade.policy.*;
import com.recast.assetupgrade.application.*;
import org.junit.jupiter.api.Test;
import java.time.Instant;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class PolicyAndAuditTest {
    @Test void workflowStateMachineAllowsOnlyDeclaredTransitions() {
        var machine = new WorkflowStateMachine();
        assertTrue(machine.canTransition(WorkflowState.APPROVED, WorkflowState.DISPATCHED));
        assertTrue(machine.canTransition(WorkflowState.DISPATCHED, WorkflowState.RETRY_PENDING));
        assertFalse(machine.canTransition(WorkflowState.COMPLETED, WorkflowState.RETRY_PENDING));
        assertThrows(IllegalStateException.class, () -> machine.transition(WorkflowState.NEW, WorkflowState.COMPLETED));
    }

    @Test void orderValidationPolicyReportsMultipleIndependentIssues() {
        var policy = new OrderValidationPolicy();
        var order = new OrderRequest("o", "tenant-a", "operator",
                List.of(new OrderLine("same", 1, 0), new OrderLine("same", 1, 0)), "CNY");
        var issues = policy.evaluate(order);
        assertTrue(issues.stream().anyMatch(item -> item.code().equals("duplicate-sku")));
        assertTrue(issues.stream().anyMatch(item -> item.code().equals("total")));
        assertFalse(policy.valid(order));
    }

    @Test void auditQuerySummarizesOperationHistory() {
        var app = ReferenceApplication.create();
        var event = ReferenceFixtures.event("tenant-a", "audit-event");
        app.assetUpgrade.submit("operator", event, null).join();
        var query = new AuditQueryService(app.audit);
        assertTrue(query.hasAccepted("tenant-a", "audit-event"));
        assertEquals(1, query.statusCounts("tenant-a", "audit-event").get("accepted"));
        assertEquals(1, query.action("tenant-a", "asset.submit").size());
    }

    @Test void batchWindowValidatesOrderAndSupportsPaging() {
        var start = Instant.parse("2026-01-01T00:00:00Z");
        var window = new BatchWindow(start, start.plusSeconds(60), 20);
        assertTrue(window.contains(start.plusSeconds(30)));
        assertFalse(window.contains(start.plusSeconds(61)));
        assertEquals(start.plusSeconds(120), window.next(java.time.Duration.ofSeconds(60)).to());
        assertThrows(IllegalArgumentException.class, () -> new BatchWindow(start.plusSeconds(1), start, 1));
    }

    @Test void tenantBoundaryReturnsStructuredIssue() {
        var app = ReferenceApplication.create();
        var boundary = new TenantBoundaryService(app.authorizer);
        var context = boundary.context("tenant-a", "unknown", "order.submit", "corr");
        assertEquals("authorization", boundary.check(context).get(0).code());
    }
}
