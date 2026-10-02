package com.recast.assetupgrade.domain;

import java.util.List;

public record ValidationIssue(String code, String message, Severity severity) {
    public enum Severity { INFO, WARNING, ERROR }

    public ValidationIssue {
        if (code == null || code.isBlank()) throw new IllegalArgumentException("code is required");
        if (message == null || message.isBlank()) throw new IllegalArgumentException("message is required");
        if (severity == null) throw new NullPointerException("severity");
    }

    public boolean blocksOperation() { return severity == Severity.ERROR; }

    public static ValidationIssue error(String code, String message) {
        return new ValidationIssue(code, message, Severity.ERROR);
    }

    public static ValidationIssue warning(String code, String message) {
        return new ValidationIssue(code, message, Severity.WARNING);
    }

    public static List<ValidationIssue> one(String code, String message) {
        return List.of(error(code, message));
    }
}
