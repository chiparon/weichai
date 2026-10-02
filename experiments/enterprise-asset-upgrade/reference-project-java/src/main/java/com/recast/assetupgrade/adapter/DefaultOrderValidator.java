package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.OrderRequest;
import com.recast.assetupgrade.port.OrderValidator;
import java.util.Optional;

public final class DefaultOrderValidator implements OrderValidator {
    @Override public Optional<String> validate(OrderRequest order) {
        if (order.orderId().length() > 80) return Optional.of("order id is too long");
        if (order.lines().size() > 100) return Optional.of("too many order lines");
        return Optional.empty();
    }

    @Override public boolean isSupportedCurrency(String currency) {
        return currency.equals("CNY") || currency.equals("USD") || currency.equals("EUR");
    }
}
