"""Download and freeze the public historical asset pool.

The repositories are intentionally kept outside Git.  This script records the
exact shallow commit, source hashes, language file counts, line counts and
license files in asset-manifest.json so later indexing runs are reproducible.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
from typing import Any


ROOT = Path(__file__).resolve().parent
SOURCES = ROOT / "asset-sources.json"
CHECKOUTS = ROOT / "source-repositories"
MANIFEST = ROOT / "asset-manifest.json"
ALLOWED_LICENSES = {"Apache-2.0", "MIT", "BSD-2-Clause", "BSD-3-Clause"}
EXTENSIONS = {
    ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx",
    ".kt", ".py", ".rb", ".rs", ".ts", ".tsx", ".vue", ".xml", ".yaml", ".yml",
}
LICENSE_NAMES = {"license", "license.txt", "license.md", "copying", "notice", "notice.txt"}


def run(*args: str, cwd: Path | None = None) -> str:
    return subprocess.check_output(args, cwd=cwd, text=True, stderr=subprocess.STDOUT).strip()


def clone(repo: dict[str, Any], depth: int) -> Path:
    destination = CHECKOUTS / repo["id"]
    if not (destination / ".git").is_dir():
        destination.parent.mkdir(parents=True, exist_ok=True)
        command = [
            "git", "clone", "--depth", str(depth), "--no-tags", "--single-branch", "--no-checkout",
            repo["url"], str(destination),
        ]
        print(f"[download] {repo['id']}", flush=True)
        subprocess.run(command, check=True)
    paths = repo.get("paths")
    if paths:
        subprocess.run(["git", "sparse-checkout", "init", "--no-cone"], cwd=destination, check=True)
        subprocess.run(["git", "sparse-checkout", "set", "--skip-checks", *paths], cwd=destination, check=True)
        subprocess.run(["git", "checkout", "--force", "HEAD"], cwd=destination, check=True)
    return destination


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def file_stats(root: Path, include_hashes: bool) -> tuple[list[dict[str, Any]], dict[str, int]]:
    files: list[dict[str, Any]] = []
    languages: dict[str, int] = {}
    for directory, directories, names in os.walk(root):
        directories[:] = [name for name in directories if name != ".git"]
        for name in sorted(names):
            path = Path(directory) / name
            extension = path.suffix.lower()
            if extension not in EXTENSIONS:
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            relative = path.relative_to(root).as_posix()
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                text = path.read_text(encoding="utf-8", errors="replace")
            lines = len(text.splitlines())
            record: dict[str, Any] = {"path": relative, "bytes": size, "lines": lines}
            if include_hashes:
                record["sha256"] = sha256(path)
            files.append(record)
            language = extension.lstrip(".")
            languages[language] = languages.get(language, 0) + lines
    return files, languages


def license_files(root: Path) -> list[str]:
    found: list[str] = []
    for path in root.iterdir():
        if path.is_file() and path.name.lower() in LICENSE_NAMES:
            found.append(path.name)
    return found


def restore_root_legal_documents(checkout: Path) -> None:
    """Restore root LICENSE/NOTICE files excluded by sparse source paths."""
    names = run("git", "ls-tree", "--name-only", "HEAD", cwd=checkout).splitlines()
    for name in names:
        if name.lower() not in LICENSE_NAMES:
            continue
        content = subprocess.check_output(["git", "show", f"HEAD:{name}"], cwd=checkout)
        (checkout / name).write_bytes(content)


def freeze(depth: int, selected: set[str] | None, include_hashes: bool) -> dict[str, Any]:
    config = json.loads(SOURCES.read_text(encoding="utf-8"))
    previous = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}
    frozen_by_id = {item["id"]: item for item in previous.get("repositories", [])}
    for source in config["repositories"]:
        if selected and source["id"] not in selected:
            continue
        if source["license"] not in ALLOWED_LICENSES:
            raise SystemExit(f"Unsupported license declaration for {source['id']}: {source['license']}")
        checkout = clone(source, depth)
        restore_root_legal_documents(checkout)
        files, languages = file_stats(checkout, include_hashes)
        frozen_by_id[source["id"]] = {
            **source,
            "commit": run("git", "rev-parse", "HEAD", cwd=checkout),
            "shallow": run("git", "rev-parse", "--is-shallow-repository", cwd=checkout) == "true",
            "files": files,
            "fileCount": len(files),
            "codeLinesByExtension": languages,
            "codeLines": sum(languages.values()),
            "licenseFiles": license_files(checkout),
        }
        print(f"[frozen] {source['id']} commit={frozen_by_id[source['id']]['commit']} lines={frozen_by_id[source['id']]['codeLines']}", flush=True)
    repositories = [frozen_by_id[source["id"]] for source in config["repositories"] if source["id"] in frozen_by_id]
    manifest = {
        "dataset": config["dataset"],
        "version": config["version"],
        "generatedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "sourceConfig": "asset-sources.json",
        "download": {"depth": depth, "shallow": True, "fileHashes": include_hashes},
        "repositories": repositories,
        "repositoryCount": len(repositories),
        "codeLines": sum(item["codeLines"] for item in repositories),
        "fileCount": sum(item["fileCount"] for item in repositories),
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--depth", type=int, default=1, help="Shallow clone depth for new repositories.")
    parser.add_argument("--repo", action="append", dest="repos", help="Only materialize this repository ID; repeatable.")
    parser.add_argument("--file-hashes", action="store_true", help="Hash every source file; slower on mounted drives.")
    args = parser.parse_args()
    if args.depth < 1:
        parser.error("--depth must be at least 1")
    manifest = freeze(args.depth, set(args.repos) if args.repos else None, args.file_hashes)
    print(json.dumps({
        "manifest": str(MANIFEST),
        "repositories": manifest["repositoryCount"],
        "files": manifest["fileCount"],
        "codeLines": manifest["codeLines"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
