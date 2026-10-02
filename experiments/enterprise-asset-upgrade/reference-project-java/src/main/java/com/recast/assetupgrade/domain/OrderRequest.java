package com.recast.assetupgrade.domain;

import java.util.List;

public record OrderRequest(
        String orderId,
        String tenantId,
        String actorId,
        List<OrderLine> lines,
        String currency) {
    public OrderRequest {
        require(orderId, "orderId");
        require(tenantId, "tenantId");
        require(actorId, "actorId");
        if (lines == null || lines.isEmpty()) throw new IllegalArgumentException("lines are required");
        lines = List.copyOf(lines);
        require(currency, "currency");
    }

    public long totalMinor() {
        return lines.stream().mapToLong(OrderLine::totalMinor).reduce(0, Math::addExact);
    }

    private static void require(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
    }
}
