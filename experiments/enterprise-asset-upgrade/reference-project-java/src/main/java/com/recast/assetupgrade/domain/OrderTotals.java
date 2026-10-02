package com.recast.assetupgrade.domain;

import java.util.List;

public record OrderTotals(long subtotalMinor, long itemCount, int distinctSkuCount) {
    public static OrderTotals from(List<OrderLine> lines) {
        long subtotal = 0;
        long count = 0;
        java.util.Set<String> skus = new java.util.HashSet<>();
        for (OrderLine line : lines) {
            subtotal = Math.addExact(subtotal, line.totalMinor());
            count = Math.addExact(count, line.quantity());
            skus.add(line.sku());
        }
        return new OrderTotals(subtotal, count, skus.size());
    }

    public boolean isFree() { return subtotalMinor == 0; }
    public boolean hasManyItems(long threshold) { return itemCount > threshold; }
}
