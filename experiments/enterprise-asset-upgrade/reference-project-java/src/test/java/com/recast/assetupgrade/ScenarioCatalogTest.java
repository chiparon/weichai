package com.recast.assetupgrade;

import com.recast.assetupgrade.scenario.ScenarioCatalog;
import com.recast.assetupgrade.scenario.ScenarioRunner;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ScenarioCatalogTest {
    @Test void catalogCoversAllFourBusinessAreas() {
        assertEquals(4, ScenarioCatalog.countByArea().size());
        assertTrue(ScenarioCatalog.countByArea().get("attachment") >= 3);
        assertTrue(ScenarioCatalog.countByArea().get("workflow") >= 2);
        assertTrue(ScenarioCatalog.countByArea().get("reconciliation") >= 2);
        assertTrue(ScenarioCatalog.countByArea().get("order") >= 3);
    }

    @Test void criteriaExposeEvidenceForReview() {
        assertTrue(ScenarioCatalog.criteria().stream().allMatch(item -> item.hasEvidence()));
        assertEquals("attachment", ScenarioCatalog.find("ATT-01").area());
        assertEquals(3, ScenarioCatalog.criteriaFor("order").size());
    }

    @Test void smokeRunnerProducesPassingOutcomes() {
        var outcomes = new ScenarioRunner(ReferenceApplication.create()).runCoreScenarios();
        assertEquals(3, outcomes.size());
        assertTrue(outcomes.stream().allMatch(item -> item.passed()), outcomes.toString());
    }
}
