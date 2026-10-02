package com.recast.assetupgrade.policy;

import com.recast.assetupgrade.domain.OrderLine;
import com.recast.assetupgrade.domain.OrderRequest;
import com.recast.assetupgrade.domain.OrderTotals;
import com.recast.assetupgrade.domain.ValidationIssue;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class OrderValidationPolicy {
    private final QuotaPolicy quota;
    public OrderValidationPolicy() { this(QuotaPolicy.defaults()); }
    public OrderValidationPolicy(QuotaPolicy quota) { this.quota = quota; }

    public List<ValidationIssue> evaluate(OrderRequest order) {
        if (order == null) return ValidationIssue.one("missing", "order is required");
        List<ValidationIssue> issues = new ArrayList<>();
        if (!quota.orderFits(order)) issues.add(ValidationIssue.error("quota", "order exceeds tenant quota"));
        Set<String> skus = new HashSet<>();
        for (OrderLine line : order.lines()) {
            if (!skus.add(line.sku())) issues.add(ValidationIssue.error("duplicate-sku", "duplicate SKU: " + line.sku()));
            if (line.quantity() > 10_000) issues.add(ValidationIssue.error("quantity", "line quantity is too large"));
        }
        OrderTotals totals = OrderTotals.from(order.lines());
        if (totals.isFree()) issues.add(ValidationIssue.error("total", "order total must be positive"));
        if (totals.hasManyItems(5_000)) issues.add(ValidationIssue.warning("large-order", "order requires batch fulfillment"));
        return List.copyOf(issues);
    }

    public boolean valid(OrderRequest order) { return evaluate(order).stream().noneMatch(ValidationIssue::blocksOperation); }
}
