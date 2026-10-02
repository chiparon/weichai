package com.recast.assetupgrade;

import com.recast.assetupgrade.domain.*;
import com.recast.assetupgrade.policy.*;
import org.junit.jupiter.api.Test;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class DomainPolicyTest {
    @Test void attachmentBytesAreDefensivelyCopied() {
        byte[] bytes = "text".getBytes();
        var attachment = new AttachmentInput("a", "tenant-a", "a.txt", "text/plain", bytes, AttachmentState.SCANNED);
        bytes[0] = 'X';
        assertEquals('t', attachment.content()[0]);
        byte[] returned = attachment.content();
        returned[0] = 'Y';
        assertEquals('t', attachment.content()[0]);
    }

    @Test void orderTotalsUseOverflowSafeArithmetic() {
        var totals = OrderTotals.from(List.of(new OrderLine("a", 2, 10), new OrderLine("b", 3, 20)));
        assertEquals(80, totals.subtotalMinor());
        assertEquals(5, totals.itemCount());
        assertEquals(2, totals.distinctSkuCount());
        assertTrue(totals.hasManyItems(4));
    }

    @Test void retryPolicyDoublesDelayAndCapsAttempts() {
        var policy = new RetryPolicy(3, Duration.ofSeconds(2));
        Instant now = Instant.parse("2026-01-01T00:00:00Z");
        assertEquals(now.plusSeconds(2), policy.nextAttempt(now, 0));
        assertEquals(now.plusSeconds(4), policy.nextAttempt(now, 1));
        assertEquals(now.plusSeconds(8), policy.nextAttempt(now, 2));
        assertFalse(policy.canRetry(3));
    }

    @Test void retryDecisionDeadLettersAtLimit() {
        var event = ReferenceFixtures.pending(ReferenceFixtures.event("tenant-a", "d-1"), 3, Instant.EPOCH);
        var decision = RetryDecision.decide(event, new RetryPolicy(3, Duration.ofSeconds(1)), Instant.EPOCH);
        assertTrue(decision.deadLetter());
        assertFalse(decision.retry());
    }

    @Test void filenamePolicyRejectsTraversalAndControls() {
        var policy = new FilenamePolicy();
        assertTrue(policy.isSafe("report.pdf"));
        assertFalse(policy.isSafe("../report.pdf"));
        assertFalse(policy.isSafe("report\n.pdf"));
        assertEquals("pdf", policy.extension("report.pdf"));
    }

    @Test void mimePolicyMatchesKnownExtensions() {
        var policy = new MimePolicy();
        assertTrue(policy.supports("application/pdf"));
        assertTrue(policy.matchesExtension("application/pdf", "PDF"));
        assertFalse(policy.matchesExtension("application/pdf", "txt"));
        assertFalse(policy.supports("image/jpeg"));
    }

    @Test void operationContextCanAddAttributesWithoutMutation() {
        var original = new OperationContext("tenant-a", "operator", "asset.submit", "corr-1", java.util.Map.of());
        var next = original.withAttribute("trace", "enabled");
        assertFalse(original.hasAttribute("trace"));
        assertEquals("enabled", next.attribute("trace", "disabled"));
    }

    @Test void validationPipelineAggregatesChecks() {
        var pipeline = new ValidationPipeline()
                .add(() -> ValidationIssue.one("first", "first issue"))
                .add(() -> List.of(ValidationIssue.warning("hint", "warning")));
        assertEquals(2, pipeline.evaluate().size());
        assertTrue(pipeline.blocked());
    }
}
