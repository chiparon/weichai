package com.recast.assetupgrade.policy;

import com.recast.assetupgrade.domain.WorkflowState;
import java.util.Map;
import java.util.Set;

/** Explicit transition table prevents a retry from bypassing approval. */
public final class WorkflowStateMachine {
    private static final Map<WorkflowState, Set<WorkflowState>> TRANSITIONS = Map.of(
            WorkflowState.NEW, Set.of(WorkflowState.APPROVED, WorkflowState.FAILED),
            WorkflowState.APPROVED, Set.of(WorkflowState.DISPATCHED, WorkflowState.RETRY_PENDING, WorkflowState.FAILED),
            WorkflowState.DISPATCHED, Set.of(WorkflowState.COMPLETED, WorkflowState.RETRY_PENDING, WorkflowState.FAILED),
            WorkflowState.RETRY_PENDING, Set.of(WorkflowState.DISPATCHED, WorkflowState.FAILED),
            WorkflowState.COMPLETED, Set.of(),
            WorkflowState.FAILED, Set.of(WorkflowState.RETRY_PENDING));

    public boolean canTransition(WorkflowState from, WorkflowState to) {
        return from != null && to != null && TRANSITIONS.getOrDefault(from, Set.of()).contains(to);
    }

    public WorkflowState transition(WorkflowState from, WorkflowState to) {
        if (!canTransition(from, to)) throw new IllegalStateException("invalid workflow transition: " + from + " -> " + to);
        return to;
    }

    public Set<WorkflowState> nextStates(WorkflowState from) { return TRANSITIONS.getOrDefault(from, Set.of()); }
    public boolean terminal(WorkflowState state) { return state == WorkflowState.COMPLETED || state == WorkflowState.FAILED; }
}
