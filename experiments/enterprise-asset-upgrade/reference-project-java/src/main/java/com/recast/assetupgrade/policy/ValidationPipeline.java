package com.recast.assetupgrade.policy;

import com.recast.assetupgrade.domain.ValidationIssue;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.Supplier;

/** Small policy composition utility used by the reference services. */
public final class ValidationPipeline {
    private final List<Supplier<List<ValidationIssue>>> checks = new ArrayList<>();

    public ValidationPipeline add(Supplier<List<ValidationIssue>> check) {
        checks.add(Objects.requireNonNull(check));
        return this;
    }

    public List<ValidationIssue> evaluate() {
        List<ValidationIssue> issues = new ArrayList<>();
        for (Supplier<List<ValidationIssue>> check : checks) {
            List<ValidationIssue> result = check.get();
            if (result != null) issues.addAll(result);
        }
        return List.copyOf(issues);
    }

    public boolean blocked() { return evaluate().stream().anyMatch(ValidationIssue::blocksOperation); }
}
