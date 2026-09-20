"""Compact, tracked evidence; generated repositories and full packets stay outside git."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import subprocess

from benchmark import load_dataset
from build import ROOT, write_json

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--datasets", nargs="+", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    runs = []
    for root in args.datasets:
        manifest, _, _ = load_dataset(root)
        report = json.loads((root / "evaluation/comparison.json").read_text(encoding="utf-8"))
        recast = json.loads((root / "evaluation/recast-memory.json").read_text(encoding="utf-8"))
        if report["datasetHash"] != manifest["datasetHash"] or recast["datasetHash"] != manifest["datasetHash"]:
            raise ValueError("Mismatched evidence")
        owners = {d["id"]: d["repository"] for d in manifest["documents"]}
        runs.append({"dataset": root.name, "datasetHash": manifest["datasetHash"], "documents": len(manifest["documents"]),
                     "sourceLines": sum(d["lines"] for d in manifest["documents"]), "repositories": len(manifest["repositories"]),
                     "crossRepositoryImports": sum(owners[e["source"]] != owners[e["target"]] for e in manifest["edges"]),
                     "stressOnlyDocuments": manifest["stressOnlyDocuments"], "k": report["k"], "maxLines": report["maxLines"],
                     "indexing": recast["indexing"], "summary": report["summary"], "observations": report["observations"]})
    implementation = list(Path(__file__).parent.glob("*.py")) + [ROOT / "scripts/evaluate-enterprise-history.mts"]
    write_json(args.output, {"createdAt": datetime.now(timezone.utc).isoformat(),
                            "baseRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                            "python": platform.python_version(), "node": subprocess.check_output(["node", "--version"], text=True).strip(),
                            "implementationHashes": {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in implementation},
                            "runs": runs})
    print(args.output)
