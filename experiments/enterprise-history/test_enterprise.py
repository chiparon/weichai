import importlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from build import build
from benchmark import Retriever, budget_files, load_dataset, score


class EnterpriseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(os.environ["ENTERPRISE_DATASET"]) if os.environ.get("ENTERPRISE_DATASET") else Path(cls.temp.name) / "dataset"
        cls.manifest = load_dataset(cls.root)[0] if os.environ.get("ENTERPRISE_DATASET") else build(cls.root)
        cls.paths = [str(p / "src") for p in (cls.root / "repositories").iterdir()]
        sys.path[:0] = cls.paths
        for module in ["erp_contracts.models", "erp_documents.upload", "erp_documents.release", "erp_portal.gateway",
                       "erp_cases.maintenance", "erp_assets.entitlement", "erp_finance.supplier", "erp_audit.dispatch"]:
            setattr(cls, module.split(".")[-1], importlib.import_module(module))
        if os.environ.get("ENTERPRISE_TARGET"):
            spec = importlib.util.spec_from_file_location("candidate_migration", os.environ["ENTERPRISE_TARGET"])
            cls.gateway = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.gateway)

    @classmethod
    def tearDownClass(cls):
        for path in cls.paths:
            sys.path.remove(path)
        for module in list(sys.modules):
            if module.startswith("erp_"):
                del sys.modules[module]
        cls.temp.cleanup()

    def setUp(self):
        m = self.models
        self.actor = m.Principal("tenant-a", frozenset({"dealer", "quality", "technician", "upload"}))
        self.asset = m.Asset("tenant-a", "engine-42", 100, 365, 1000)
        self.evidence = self.upload.receive_attachment(self.actor, "tenant-a", "inspection.pdf", b"%PDF-report", "application/pdf", True)
        self.state = {"ledger": {}, "events": {}}

    def claim(self, **overrides):
        values = dict(state=self.state, actor=self.actor, asset=self.asset, evidence=self.evidence, day=465, case_id="C-1", amount=self.models.Money(12500))
        values.update(overrides)
        return self.gateway.submit_warranty(**values)

    def test_warranty_chain_and_idempotent_retry(self):
        self.claim()
        self.claim()
        self.assertEqual(list(self.state["ledger"].values()), [(12500, "CNY")])
        self.assertEqual(len(self.state["events"]), 1)

    def test_supplier_quality_chain(self):
        self.gateway.submit_quality(self.state, self.actor, "tenant-a", self.evidence, "Q-1", self.models.Money(123), 3, 10)
        self.assertEqual(self.state["ledger"][("tenant-a", "supplier-debit", "Q-1")], (369, "CNY"))
        self.assertEqual(len(self.state["events"]), 1)

    def test_maintenance_chain(self):
        result = self.maintenance.schedule_service(self.actor, self.asset, self.evidence, 500, "M-1", self.state["events"])
        self.assertEqual(result["status"], "scheduled")
        self.assertFalse(self.state["ledger"])
        self.assertEqual(len(self.state["events"]), 1)

    def test_wrong_tenant_and_missing_role(self):
        for actor in [self.models.Principal("tenant-b", self.actor.roles), self.models.Principal("tenant-a", frozenset())]:
            with self.subTest(actor=actor), self.assertRaises(PermissionError):
                self.claim(actor=actor)
        self.assertEqual(self.state, {"ledger": {}, "events": {}})

    def test_quarantine_blocks_finance(self):
        evidence = self.models.Evidence("tenant-a", "hash", "application/pdf", 3, False)
        with self.assertRaises(ValueError):
            self.claim(evidence=evidence)
        self.assertEqual(self.state, {"ledger": {}, "events": {}})

    def test_foreign_evidence_blocks_finance(self):
        evidence = self.models.Evidence("tenant-b", "hash", "application/pdf", 3, True)
        with self.assertRaises(PermissionError):
            self.claim(evidence=evidence)

    def test_upload_rejects_path_traversal(self):
        for filename in ["../report.pdf", "x\\report.pdf", "/etc/report.pdf", "..", ""]:
            with self.subTest(filename=filename), self.assertRaises(ValueError):
                self.upload.receive_attachment(self.actor, "tenant-a", filename, b"%PDF-test", "application/pdf", True)

    def test_upload_limits_and_signature(self):
        for payload, media in [(b"fake", "application/pdf"), (b"%PDF-x", "text/plain"), (b"", "application/pdf"), (b"%PDF-" + b"x" * 1048576, "application/pdf")]:
            with self.subTest(size=len(payload), media=media), self.assertRaises(ValueError):
                self.upload.receive_attachment(self.actor, "tenant-a", "report.pdf", payload, media, True)

    def test_inclusive_warranty_and_invalid_dates(self):
        self.assertEqual(self.entitlement.require_warranty(self.asset, "tenant-a", 465), "engine-42")
        for day in [99, 466]:
            with self.assertRaises(ValueError):
                self.claim(day=day)

    def test_excessive_operating_hours(self):
        with self.assertRaises(ValueError):
            self.claim(asset=self.models.Asset("tenant-a", "engine-42", 100, 365, 5001))

    def test_maintenance_meter_boundaries(self):
        for hours in [501, 1001, -1]:
            with self.assertRaises(ValueError):
                self.maintenance.schedule_service(self.actor, self.asset, self.evidence, hours, "M-1", {})

    def test_changed_retry_amount_rejected_without_mutation(self):
        self.claim()
        before = repr(self.state)
        with self.assertRaises(ValueError):
            self.claim(amount=self.models.Money(12501))
        self.assertEqual(repr(self.state), before)

    def test_event_conflict_rolls_back_posting(self):
        key = ("tenant-a", "warranty", "C-1")
        self.state["events"][key] = {"conflicting": "event"}
        before = repr(self.state)
        with self.assertRaises(ValueError):
            self.claim()
        self.assertEqual(repr(self.state), before)

    def test_quality_event_conflict_rolls_back_debit(self):
        self.state["events"][("tenant-a", "supplier-debit", "Q-1")] = {"conflict": True}
        before = repr(self.state)
        with self.assertRaises(ValueError):
            self.gateway.submit_quality(self.state, self.actor, "tenant-a", self.evidence, "Q-1", self.models.Money(123), 3, 10)
        self.assertEqual(repr(self.state), before)

    def test_tenant_scoped_idempotency(self):
        self.claim()
        self.claim(actor=self.models.Principal("tenant-b", self.actor.roles), asset=self.models.Asset("tenant-b", "E-2", 100, 365, 100),
                   evidence=self.models.Evidence("tenant-b", "hash", "application/pdf", 10, True))
        self.assertEqual(len(self.state["ledger"]), 2)

    def test_money_and_supplier_quantity_validation(self):
        for amount in [1.5, -1, True]:
            with self.assertRaises(ValueError):
                self.models.Money(amount)
        for rejected in [0, 11, -1, 1.5, True]:
            with self.assertRaises(ValueError):
                self.supplier.calculate_debit(self.models.Money(10), rejected, 10)

    def test_dispatch_failure_can_retry(self):
        self.claim()
        delivered = set()
        def fail(_):
            raise OSError("transport failed")
        with self.assertRaises(OSError):
            self.dispatch.dispatch_pending(self.state["events"], delivered, fail)
        self.assertFalse(delivered)
        sent = []
        self.dispatch.dispatch_pending(self.state["events"], delivered, sent.append)
        self.dispatch.dispatch_pending(self.state["events"], delivered, sent.append)
        self.assertEqual(len(sent), 1)

    def test_cross_repository_connectivity_and_labels(self):
        manifest, tasks, sources = load_dataset(self.root)
        owners = {d["id"]: d["repository"] for d in manifest["documents"]}
        touched = {owners[e[k]] for e in manifest["edges"] if owners[e["source"]] != owners[e["target"]] for k in ["source", "target"]}
        self.assertEqual(touched, set(manifest["repositories"]))
        self.assertEqual(len(tasks), 24)
        for task in tasks:
            self.assertFalse(any(task["id"] in source for source in sources.values()))


class HarnessTests(unittest.TestCase):
    def test_reproducible_stress_and_frozen_data(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / "a", Path(directory) / "b"
            a, b = build(first, 2), build(second, 2)
            self.assertEqual(a["datasetHash"], b["datasetHash"])
            self.assertEqual(a["stressOnlyDocuments"], 16)
            doc = a["documents"][0]
            (first / "repositories" / doc["repository"] / doc["path"]).write_text("changed", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Frozen source"):
                load_dataset(first)

    def test_git_history_contains_observable_policy_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "history"
            build(root, git_history=True)
            repo = root / "repositories/identity-access"
            old = subprocess.check_output(["git", "show", "synthetic-v1:src/erp_identity/policy.py"], cwd=repo, text=True)
            current = subprocess.check_output(["git", "show", "synthetic-v2:src/erp_identity/policy.py"], cwd=repo, text=True)
            self.assertNotIn("actor.tenant != tenant", old)
            self.assertIn("actor.tenant != tenant", current)

    def test_metric_deduplication_and_missing_evidence(self):
        task = {"primary": ["a"], "required": ["a", "b"], "relevance": {"a": 3, "b": 2}}
        partial = score(task, ["a", "a"], ["a"])
        self.assertEqual(partial["recallAtK"], .5)
        self.assertFalse(partial["evidenceComplete"])
        self.assertLess(partial["ndcgAtK"], 1)
        self.assertEqual(score(task, ["a", "b"], ["a", "b"])["ndcgAtK"], 1)
        self.assertEqual(score(task, [], [])["primaryMRR"], 0)

    def test_ranker_budget_and_edge_ablation(self):
        docs = [{"id": "a", "repository": "one", "lines": 3}, {"id": "b", "repository": "two", "lines": 3}]
        retriever = Retriever(docs, {"a": "warranty", "b": "other"}, [{"source": "a", "target": "b"}])
        self.assertEqual(retriever.rank("warranty", "bm25-local-imports"), ["a"])
        self.assertEqual(retriever.rank("warranty", "bm25-cross-imports"), ["a", "b"])
        self.assertEqual(budget_files(["a", "b"], retriever.documents, 10, 3), ["a"])

    def test_build_refuses_to_overwrite_existing_data(self):
        with tempfile.TemporaryDirectory() as directory:
            build(directory)
            with self.assertRaises(ValueError):
                build(directory)


if __name__ == "__main__":
    unittest.main()
