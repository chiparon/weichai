package com.recast.assetupgrade.domain;

import java.util.List;

public record AcceptanceCriterion(String id, String area, String description, List<String> evidence) {
    public AcceptanceCriterion {
        if (id == null || id.isBlank()) throw new IllegalArgumentException("id is required");
        if (area == null || area.isBlank()) throw new IllegalArgumentException("area is required");
        if (description == null || description.isBlank()) throw new IllegalArgumentException("description is required");
        evidence = List.copyOf(evidence == null ? List.of() : evidence);
    }

    public boolean hasEvidence() { return !evidence.isEmpty(); }
}
