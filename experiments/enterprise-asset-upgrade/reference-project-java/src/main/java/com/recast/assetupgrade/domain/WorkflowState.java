package com.recast.assetupgrade.domain;

public enum WorkflowState {
    NEW,
    APPROVED,
    DISPATCHED,
    RETRY_PENDING,
    COMPLETED,
    FAILED
}
