package com.recast.assetupgrade.scenario;

import com.recast.assetupgrade.domain.AcceptanceCriterion;
import java.util.List;
import java.util.Map;

/** Public, deterministic acceptance matrix shared by benchmark reports and tests. */
public final class ScenarioCatalog {
    private static final List<AcceptanceCriterion> CRITERIA = List.of(
            new AcceptanceCriterion("ATT-01", "attachment", "Reject a cross-tenant attachment", List.of("authorization audit", "no persistence")),
            new AcceptanceCriterion("ATT-02", "attachment", "Quarantine an attachment before scanning", List.of("quarantine state", "scanner invocation")),
            new AcceptanceCriterion("ATT-03", "attachment", "Reject unsafe names and unsupported MIME types", List.of("validation issue", "no scanner call")),
            new AcceptanceCriterion("WF-01", "workflow", "Dispatch an approved event once", List.of("idempotency claim", "dispatch history")),
            new AcceptanceCriterion("WF-02", "workflow", "Release a claim after a retryable transport failure", List.of("retry result", "claim release")),
            new AcceptanceCriterion("REC-01", "reconciliation", "Process only due events for the authorized tenant", List.of("batch report", "tenant audit")),
            new AcceptanceCriterion("REC-02", "reconciliation", "Dead-letter events after the retry budget", List.of("dead-letter record", "store removal")),
            new AcceptanceCriterion("ORD-01", "order", "Reserve inventory before committing an order", List.of("reservation", "commit")),
            new AcceptanceCriterion("ORD-02", "order", "Release inventory when commit fails", List.of("rollback", "reservation count")),
            new AcceptanceCriterion("ORD-03", "order", "Make duplicate order submission idempotent", List.of("single commit", "duplicate result")));

    private ScenarioCatalog() { }
    public static List<AcceptanceCriterion> criteria() { return CRITERIA; }
    public static List<AcceptanceCriterion> criteriaFor(String area) { return CRITERIA.stream().filter(item -> item.area().equals(area)).toList(); }
    public static Map<String, Long> countByArea() {
        return CRITERIA.stream().collect(java.util.stream.Collectors.groupingBy(AcceptanceCriterion::area, java.util.stream.Collectors.counting()));
    }
    public static AcceptanceCriterion find(String id) { return CRITERIA.stream().filter(item -> item.id().equals(id)).findFirst().orElseThrow(); }
}
