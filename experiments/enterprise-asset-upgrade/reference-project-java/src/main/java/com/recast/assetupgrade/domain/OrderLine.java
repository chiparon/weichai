package com.recast.assetupgrade.domain;

public record OrderLine(String sku, int quantity, long unitPriceMinor) {
    public OrderLine {
        if (sku == null || sku.isBlank()) throw new IllegalArgumentException("sku is required");
        if (quantity <= 0) throw new IllegalArgumentException("quantity must be positive");
        if (unitPriceMinor < 0) throw new IllegalArgumentException("unit price cannot be negative");
    }

    public long totalMinor() {
        return Math.multiplyExact(quantity, unitPriceMinor);
    }
}
