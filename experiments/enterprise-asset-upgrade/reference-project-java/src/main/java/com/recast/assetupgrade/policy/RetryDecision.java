package com.recast.assetupgrade.policy;

import com.recast.assetupgrade.domain.PendingEvent;
import java.time.Instant;

public record RetryDecision(boolean retry, boolean deadLetter, Instant nextAttempt, String reason) {
    public static RetryDecision retryAt(Instant at, String reason) { return new RetryDecision(true, false, at, reason); }
    public static RetryDecision deadLetter(String reason) { return new RetryDecision(false, true, null, reason); }
    public static RetryDecision skip(String reason) { return new RetryDecision(false, false, null, reason); }

    public static RetryDecision decide(PendingEvent event, RetryPolicy policy, Instant now) {
        if (!event.retryable()) return skip("event is not retryable");
        if (!policy.canRetry(event.attempts())) return deadLetter("retry limit reached");
        return retryAt(policy.nextAttempt(now, event.attempts()), "eligible for retry");
    }
}
