package com.recast.assetupgrade.domain;

import java.util.List;

public record ReconciliationReport(
        int examined,
        int retried,
        int succeeded,
        int failed,
        List<String> eventIds) {
    public ReconciliationReport {
        if (examined < 0 || retried < 0 || succeeded < 0 || failed < 0) {
            throw new IllegalArgumentException("report counts cannot be negative");
        }
        eventIds = List.copyOf(eventIds);
    }
}
