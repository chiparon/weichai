package com.recast.assetupgrade.port;

import com.recast.assetupgrade.domain.AssetEvent;
import com.recast.assetupgrade.domain.DeliveryResult;
import java.util.concurrent.CompletableFuture;

public interface WorkflowDispatcher {
    CompletableFuture<DeliveryResult> dispatch(AssetEvent event);
    boolean supports(String eventType);
}
