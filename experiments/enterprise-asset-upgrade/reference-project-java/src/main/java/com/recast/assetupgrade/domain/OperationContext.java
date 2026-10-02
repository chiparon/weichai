package com.recast.assetupgrade.domain;

import java.util.Map;
import java.util.Objects;

/** Immutable request context carried across adapters and audit records. */
public record OperationContext(
        String tenantId,
        String actorId,
        String operation,
        String correlationId,
        Map<String, String> attributes) {
    public OperationContext {
        require(tenantId, "tenantId");
        require(actorId, "actorId");
        require(operation, "operation");
        require(correlationId, "correlationId");
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    public boolean hasAttribute(String name) {
        return attributes.containsKey(name);
    }

    public String attribute(String name, String fallback) {
        return attributes.getOrDefault(name, fallback);
    }

    public OperationContext withAttribute(String name, String value) {
        var next = new java.util.HashMap<>(attributes);
        next.put(Objects.requireNonNull(name), Objects.requireNonNull(value));
        return new OperationContext(tenantId, actorId, operation, correlationId, next);
    }

    private static void require(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
    }
}
