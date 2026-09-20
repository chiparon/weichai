"""Materialize independently indexable repositories and frozen evaluation inputs."""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess
import textwrap

from corpus import REPOSITORIES, RELEASE_ONE, SOURCES
from tasks import TASKS, CHINESE

ROOT = Path(__file__).resolve().parents[2]
DEFAULT = ROOT / "results" / "enterprise-history"
TARGET_SOURCE = '''"""New service portal: implement against the enterprise history contracts."""

def submit_warranty(state, actor, asset, evidence, day, case_id, amount):
    raise NotImplementedError("migrate warranty workflow")

def submit_quality(state, actor, tenant, evidence, case_id, unit_cost, rejected, delivered):
    raise NotImplementedError("migrate supplier quality workflow")
'''


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def module_path(module):
    package = module.split(".")[0]
    repo = next(name for name, (pkg, _) in REPOSITORIES.items() if pkg == package)
    return repo, "src/" + module.replace(".", "/") + ".py"


def clean_source(source):
    return textwrap.dedent(source).strip() + "\n"


def build(output, noise_per_repo=0, git_history=False):
    output = Path(output).resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError(f"Use a new or empty output directory: {output}")
    output.mkdir(parents=True, exist_ok=True)
    corpus = output / "repositories"
    documents = []
    for name, (package, purpose) in REPOSITORIES.items():
        repo = corpus / name
        source_root = repo / "src" / package
        source_root.mkdir(parents=True)
        (source_root / "__init__.py").write_text("", encoding="utf-8")
        (repo / "README.md").write_text(f"# {name}\n\n{purpose}.\n\nSynthetic enterprise fixture, release 2. Uses sibling repositories via PYTHONPATH.\n", encoding="utf-8")
        (repo / ".gitignore").write_text("__pycache__/\n*.pyc\n", encoding="utf-8")
        write_json(repo / "manifest.json", {"repository": name, "language": "Python", "languageVersion": "3.10+", "sourceRoot": "src", "provenance": "model-authored synthetic; not Apache Commons or customer code"})
        for module, source in SOURCES.items():
            if module.startswith(package + "."):
                (source_root / (module.split(".")[1] + ".py")).write_text(clean_source(source), encoding="utf-8")
        for n in range(noise_per_repo):
            # Stress-only administrative views. They do not create new tasks or
            # independent enterprise scenarios, and are recorded separately.
            (source_root / f"archive_view_{n:04}.py").write_text(
                f'def summarize_archive_{n:04}(records, tenant):\n'
                f'    """Read-only archive partition {n}; count records for a tenant."""\n'
                '    return sum(1 for row in records if row["tenant"] == tenant)\n', encoding="utf-8")
        if git_history:
            env = {**os.environ, "GIT_AUTHOR_NAME": "Synthetic fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid", "GIT_COMMITTER_NAME": "Synthetic fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"}
            def git(*args):
                subprocess.run(["git", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", *args], cwd=repo, env=env, check=True, capture_output=True)
            git("init", "--quiet")
            for module, source in RELEASE_ONE.items():
                owner, rel = module_path(module)
                if owner == name:
                    (repo / rel).write_text(clean_source(source), encoding="utf-8")
            env.update(GIT_AUTHOR_DATE="2024-01-01T00:00:00Z", GIT_COMMITTER_DATE="2024-01-01T00:00:00Z")
            git("add", ".")
            git("commit", "-qm", "Synthetic release 1: intranet workflow")
            git("tag", "synthetic-v1")
            for module in RELEASE_ONE:
                owner, rel = module_path(module)
                if owner == name:
                    (repo / rel).write_text(clean_source(SOURCES[module]), encoding="utf-8")
            env.update(GIT_AUTHOR_DATE="2025-01-01T00:00:00Z", GIT_COMMITTER_DATE="2025-01-01T00:00:00Z")
            git("add", ".")
            git("commit", "--allow-empty", "-qm", "Synthetic release 2: tenant isolation and inclusive coverage")
            git("tag", "synthetic-v2")
    for module in SOURCES:
        repo, rel = module_path(module)
        documents.append({"id": module, "repository": repo, "path": rel})
    for repo, (pkg, _) in REPOSITORIES.items():
        for n in range(noise_per_repo):
            module = f"{pkg}.archive_view_{n:04}"
            documents.append({"id": module, "repository": repo, "path": f"src/{pkg}/archive_view_{n:04}.py"})
    edges = []
    known = {d["id"] for d in documents}
    for doc in documents:
        content = (corpus / doc["repository"] / doc["path"]).read_bytes()
        doc["sha256"] = hashlib.sha256(content).hexdigest()
        doc["lines"] = len(content.splitlines())
        for node in ast.walk(ast.parse(content)):
            if isinstance(node, ast.ImportFrom) and node.module in known:
                edges.append({"source": doc["id"], "target": node.module, "kind": "python-import"})
    tasks = []
    for name, split, query, primary, required in TASKS:
        for language, text in [("en", query), ("zh", CHINESE[name])]:
            tasks.append({"id": name + "-" + language, "family": name, "split": split, "language": language,
                          "requirement": text, "primary": primary, "required": required,
                          "relevance": {module: 3 if module in primary else 2 for module in required}})
    manifest = {"version": 1, "provenance": "synthetic-model-authored", "sourceRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                "release": "synthetic-v2", "repositories": list(REPOSITORIES), "documents": documents, "edges": edges,
                "stressOnlyDocuments": noise_per_repo * len(REPOSITORIES), "independentTaskFamilies": len(TASKS),
                "gitHistory": git_history, "limitations": ["single synthetic enterprise", "shared code across dev and test tasks", "paired languages are not independent samples", "stress templates add size, not business diversity"]}
    manifest["datasetHash"] = hashlib.sha256(json.dumps({"documents": documents, "tasks": tasks}, sort_keys=True).encode()).hexdigest()
    write_json(output / "manifest.json", manifest)
    write_json(output / "evaluation" / "tasks.json", tasks)
    target = output / "target" / "src"
    target.mkdir(parents=True)
    (target / "migration.py").write_text(TARGET_SOURCE, encoding="utf-8")
    write_json(output / "evaluation" / "bindings.example.json", {repo: {"repositoryId": "REPLACE_WITH_INDEX_ID", "analysisRevision": "REPLACE_WITH_READY_REVISION"} for repo in REPOSITORIES})
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT)
    parser.add_argument("--noise-per-repo", type=int, default=0)
    parser.add_argument("--git-history", action="store_true")
    args = parser.parse_args()
    if not 0 <= args.noise_per_repo <= 10000:
        parser.error("noise-per-repo must be 0..10000")
    manifest = build(args.output, args.noise_per_repo, args.git_history)
    print(json.dumps({"output": str(args.output), "repositories": len(manifest["repositories"]), "documents": len(manifest["documents"]), "hash": manifest["datasetHash"]}))
