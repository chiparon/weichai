package com.recast.assetupgrade.domain;

import java.util.List;

public record ScenarioOutcome(String scenarioId, boolean passed, List<String> observations, List<ValidationIssue> issues) {
    public ScenarioOutcome {
        if (scenarioId == null || scenarioId.isBlank()) throw new IllegalArgumentException("scenarioId is required");
        observations = List.copyOf(observations == null ? List.of() : observations);
        issues = List.copyOf(issues == null ? List.of() : issues);
    }

    public static ScenarioOutcome pass(String id, String observation) { return new ScenarioOutcome(id, true, List.of(observation), List.of()); }
    public static ScenarioOutcome fail(String id, String observation, ValidationIssue issue) { return new ScenarioOutcome(id, false, List.of(observation), List.of(issue)); }
}
