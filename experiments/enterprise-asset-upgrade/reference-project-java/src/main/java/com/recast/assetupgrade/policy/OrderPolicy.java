package com.recast.assetupgrade.policy;

import com.recast.assetupgrade.domain.OrderLine;
import com.recast.assetupgrade.domain.OrderRequest;
import com.recast.assetupgrade.port.OrderValidator;
import java.util.HashSet;
import java.util.Optional;
import java.util.Set;

public final class OrderPolicy {
    private final OrderValidator validator;

    public OrderPolicy(OrderValidator validator) {
        this.validator = validator;
    }

    public Optional<String> validate(OrderRequest order) {
        Optional<String> external = validator.validate(order);
        if (external.isPresent()) return external;
        if (!validator.isSupportedCurrency(order.currency())) return Optional.of("unsupported currency");
        Set<String> skus = new HashSet<>();
        for (OrderLine line : order.lines()) {
            if (!skus.add(line.sku())) return Optional.of("duplicate SKU");
            if (line.quantity() > 10_000) return Optional.of("quantity exceeds limit");
        }
        if (order.totalMinor() <= 0) return Optional.of("order total must be positive");
        return Optional.empty();
    }
}
