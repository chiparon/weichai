package com.recast.assetupgrade.port;

import com.recast.assetupgrade.domain.DispatchAttempt;
import java.util.List;

public interface DispatchHistory {
    void append(DispatchAttempt attempt);
    List<DispatchAttempt> find(String tenantId, String eventId);
}
