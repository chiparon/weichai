package com.recast.assetupgrade.scenario;

import com.recast.assetupgrade.ReferenceApplication;
import com.recast.assetupgrade.domain.*;
import java.util.ArrayList;
import java.util.List;

/** Runs a small smoke matrix without coupling the benchmark to JUnit. */
public final class ScenarioRunner {
    private final ReferenceApplication app;
    public ScenarioRunner(ReferenceApplication app) { this.app = app; }

    public List<ScenarioOutcome> runCoreScenarios() {
        List<ScenarioOutcome> outcomes = new ArrayList<>();
        outcomes.add(runAttachmentBoundary());
        outcomes.add(runWorkflowIdempotency());
        outcomes.add(runOrderAtomicity());
        return List.copyOf(outcomes);
    }

    private ScenarioOutcome runAttachmentBoundary() {
        try {
            app.attachmentIntake.accept("operator", new AttachmentInput("scenario-doc", "tenant-a", "scenario.pdf", "application/pdf", "%PDF-".getBytes(), AttachmentState.SCANNED)).join();
            return ScenarioOutcome.pass("ATT-SMOKE", "clean attachment scanned and persisted");
        } catch (RuntimeException error) {
            return ScenarioOutcome.fail("ATT-SMOKE", "attachment flow failed", ValidationIssue.error("exception", error.getMessage()));
        }
    }

    private ScenarioOutcome runWorkflowIdempotency() {
        AssetEvent event = new AssetEvent("scenario-event", "tenant-a", "asset", "asset.created", app.clock.now(), null, WorkflowState.APPROVED);
        DeliveryResult first = app.assetUpgrade.submit("operator", event, null).join();
        DeliveryResult second = app.assetUpgrade.submit("operator", event, null).join();
        return first.accepted() && second.status() == DeliveryStatus.DUPLICATE
                ? ScenarioOutcome.pass("WF-SMOKE", "second delivery was idempotently suppressed")
                : ScenarioOutcome.fail("WF-SMOKE", "duplicate delivery was not suppressed", ValidationIssue.error("idempotency", "unexpected delivery statuses"));
    }

    private ScenarioOutcome runOrderAtomicity() {
        app.committer.failNextCommit();
        OrderResult result = app.orderBridge.submit(new OrderRequest("scenario-order", "tenant-a", "operator", List.of(new OrderLine("scenario", 1, 100)), "CNY")).join();
        return result.status() == OrderStatus.ROLLED_BACK && app.inventory.reservationCount() == 0
                ? ScenarioOutcome.pass("ORD-SMOKE", "failed commit released the reservation")
                : ScenarioOutcome.fail("ORD-SMOKE", "reservation remained after failed commit", ValidationIssue.error("atomicity", "rollback invariant failed"));
    }
}
