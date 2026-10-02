package com.recast.assetupgrade.port;

import com.recast.assetupgrade.domain.DeadLetterEvent;
import java.util.List;

public interface DeadLetterSink {
    void publish(DeadLetterEvent event);
    List<DeadLetterEvent> findForTenant(String tenantId);
}
