"""Run business assertions against a trusted candidate's migrated gateway."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

from build import DEFAULT

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=DEFAULT)
    parser.add_argument("--target", type=Path, help="Trusted Python file exporting submit_warranty and submit_quality")
    args = parser.parse_args()
    target = (args.target or args.dataset / "target/src/migration.py").resolve()
    if not target.is_file():
        parser.error(f"Target does not exist: {target}")
    result = subprocess.run([sys.executable, "-m", "unittest", "test_enterprise.EnterpriseTests", "-v"],
                            cwd=Path(__file__).resolve().parent,
                            env={**os.environ, "ENTERPRISE_DATASET": str(args.dataset.resolve()), "ENTERPRISE_TARGET": str(target)})
    raise SystemExit(result.returncode)
