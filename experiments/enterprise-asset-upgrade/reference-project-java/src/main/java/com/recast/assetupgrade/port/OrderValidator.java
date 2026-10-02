package com.recast.assetupgrade.port;

import com.recast.assetupgrade.domain.OrderRequest;
import java.util.Optional;

public interface OrderValidator {
    Optional<String> validate(OrderRequest order);
    boolean isSupportedCurrency(String currency);
}
