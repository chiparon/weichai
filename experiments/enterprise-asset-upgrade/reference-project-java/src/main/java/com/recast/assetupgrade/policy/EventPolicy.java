package com.recast.assetupgrade.policy;

import com.recast.assetupgrade.domain.AssetEvent;
import com.recast.assetupgrade.domain.WorkflowState;
import com.recast.assetupgrade.port.WorkflowDispatcher;

public final class EventPolicy {
    private final WorkflowDispatcher dispatcher;

    public EventPolicy(WorkflowDispatcher dispatcher) {
        this.dispatcher = dispatcher;
    }

    public String validate(AssetEvent event) {
        if (event == null) return "event is required";
        if (!dispatcher.supports(event.eventType())) return "unsupported event type";
        if (event.state() != WorkflowState.APPROVED && event.state() != WorkflowState.RETRY_PENDING) {
            return "event is not approved for dispatch";
        }
        return null;
    }

    public boolean canDispatch(AssetEvent event) {
        return validate(event) == null;
    }
}
