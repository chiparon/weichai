"""Compile the five checked-in baseline translations without calling an LLM."""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

from csharp_compile import compile_csharp, compiler_status


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "output"
CASES = [
    ("case-1-exact-match", "OrderService"),
    ("case-2-partial-match", "OrderValidator"),
    ("case-3-different-signature", "PriceFormatter"),
    ("case-4-exception-mapping", "PaymentService"),
    ("case-5-collection-transform", "ReportService"),
]


def main() -> int:
    compiler = compiler_status()
    if not compiler["available"]:
        print("[FAIL] No usable .NET SDK or C# compiler was found.")
        return 2

    print(f"[compiler] {compiler['kind']}: {compiler['command']}")
    results = []
    for case_id, class_name in CASES:
        source = OUTPUT / f"{case_id}.cs"
        if not source.is_file():
            result = {"success": False, "errors": [f"Missing baseline source: {source}"]}
        else:
            result = compile_csharp(source.read_text(encoding="utf-8"), class_name)
        results.append({"id": case_id, "className": class_name, **result})
        print(f"[{'PASS' if result['success'] else 'FAIL'}] {case_id}")
        for error in result.get("errors", [])[:3]:
            print(f"  {error}")

    report = {
        "schemaVersion": "1.0",
        "validatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "compiler": compiler,
        "passed": sum(1 for result in results if result["success"]),
        "total": len(results),
        "results": results,
    }
    report_path = OUTPUT / "baseline_compile_latest.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[result] {report['passed']}/{report['total']} passed")
    print(f"[report] {report_path}")
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
