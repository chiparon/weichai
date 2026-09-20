"""Frozen file-level retrieval controls; no labels are supplied to rankers."""
import argparse
import ast
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import random
import re
import statistics
import time

from build import DEFAULT, write_json


def tokens(text):
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text).lower()
    return re.findall(r"[a-z]+|\d+|[\u4e00-\u9fff]", text)


def load_dataset(root):
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    tasks = json.loads((root / "evaluation/tasks.json").read_text(encoding="utf-8"))
    documents = manifest["documents"]
    for doc in documents:
        source = (root / "repositories" / doc["repository"] / doc["path"]).read_bytes()
        if hashlib.sha256(source).hexdigest() != doc["sha256"]:
            raise ValueError(f"Frozen source changed: {doc['id']}")
    actual_hash = hashlib.sha256(json.dumps({"documents": documents, "tasks": tasks}, sort_keys=True).encode()).hexdigest()
    if actual_hash != manifest["datasetHash"]:
        raise ValueError("Frozen dataset manifest or tasks changed")
    if len({t["id"] for t in tasks}) != len(tasks):
        raise ValueError("Duplicate task IDs")
    known = {d["id"] for d in documents}
    for task in tasks:
        if not set(task["primary"]) <= set(task["required"]) <= known:
            raise ValueError("Unresolvable labels")
    # Candidate text comes ONLY from source paths declared in the manifest.
    sources = {d["id"]: (root / "repositories" / d["repository"] / d["path"]).read_text(encoding="utf-8") for d in documents}
    actual_edges = [{"source": doc["id"], "target": node.module, "kind": "python-import"}
                    for doc in documents for node in ast.walk(ast.parse(sources[doc["id"]]))
                    if isinstance(node, ast.ImportFrom) and node.module in known]
    if manifest["edges"] != actual_edges:
        raise ValueError("Dependency graph must be derived from the frozen source imports")
    return manifest, tasks, sources


class Retriever:
    def __init__(self, documents, sources, edges):
        self.documents = {d["id"]: d for d in documents}
        self.ids = sorted(self.documents)
        self.counts = {key: Counter(tokens(key + "\n" + sources[key])) for key in self.ids}
        self.df = Counter(word for counts in self.counts.values() for word in counts)
        self.average_length = statistics.mean(sum(c.values()) for c in self.counts.values())
        self.edges = defaultdict(set)
        for edge in edges:
            self.edges[edge["source"]].add(edge["target"])

    def rank(self, query, variant):
        if variant == "empty-context":
            return []
        if variant == "random":
            values = self.ids.copy()
            random.Random(hashlib.sha256(query.encode()).hexdigest()).shuffle(values)
            return values
        query_terms = Counter(tokens(query))
        n = len(self.ids)
        scores = {}
        for key, counts in self.counts.items():
            if variant == "tfidf":
                idf = lambda word: math.log((n + 1) / (self.df[word] + 1)) + 1
                dot = sum(counts[w] * q * idf(w) ** 2 for w, q in query_terms.items())
                norm = math.sqrt(sum((v * idf(w)) ** 2 for w, v in counts.items()))
                qnorm = math.sqrt(sum((v * idf(w)) ** 2 for w, v in query_terms.items()))
                scores[key] = dot / (norm * qnorm) if norm and qnorm else 0
            else:
                length = sum(counts.values())
                scores[key] = sum(math.log(1 + (n - self.df[w] + .5) / (self.df[w] + .5)) *
                                  counts[w] * 2.2 / (counts[w] + 1.2 * (.25 + .75 * length / self.average_length))
                                  for w in query_terms if counts[w])
        ranked = sorted((key for key in self.ids if scores[key] > 0), key=lambda key: (-scores[key], key))
        if variant in {"bm25", "tfidf"}:
            return ranked
        # Fixed, label-free policy: two lexical seeds, breadth-first imports up
        # to two hops, then lexical remainder. The ablation removes only edges
        # crossing repository boundaries; its lexical candidate pool is identical.
        chosen = ranked[:2]
        frontier = chosen.copy()
        for _ in range(2):
            next_frontier = []
            for key in frontier:
                for dep in sorted(self.edges[key], key=lambda d: (-scores[d], d)):
                    if variant == "bm25-local-imports" and self.documents[key]["repository"] != self.documents[dep]["repository"]:
                        continue
                    if dep not in chosen:
                        chosen.append(dep)
                        next_frontier.append(dep)
            frontier = next_frontier
        return chosen + [key for key in ranked if key not in chosen]


def budget_files(ranked, documents, k, max_lines):
    selected, used = [], 0
    for key in dict.fromkeys(ranked):
        lines = documents[key]["lines"]
        if used + lines <= max_lines:
            selected.append(key)
            used += lines
        if len(selected) >= k:
            break
    return selected


def score(task, ranked, covered, k=10):
    ranked = list(dict.fromkeys(ranked))[:k]
    relevant = task["relevance"]
    ideal = sum((2 ** grade - 1) / math.log2(i + 2) for i, grade in enumerate(sorted(relevant.values(), reverse=True)[:k]))
    dcg = sum((2 ** relevant.get(key, 0) - 1) / math.log2(i + 2) for i, key in enumerate(ranked))
    first = next((i + 1 for i, key in enumerate(ranked) if key in task["primary"]), None)
    required = set(task["required"])
    return {"recallAtK": len(set(ranked) & set(relevant)) / len(relevant),
            "primaryMRR": 1 / first if first else 0, "ndcgAtK": dcg / ideal if ideal else 0,
            "evidenceCoverage": len(set(covered) & required) / len(required),
            "evidenceComplete": required <= set(covered)}


def summarize(rows):
    metrics = ["recallAtK", "primaryMRR", "ndcgAtK", "evidenceCoverage", "evidenceComplete", "sourceLines", "latencyMs"]
    values = {key: statistics.mean(float(row[key]) for row in rows) for key in metrics}
    values["tasks"] = len(rows)
    values["failures"] = sum(row.get("status", "ok") == "error" for row in rows)
    values["p95LatencyMs"] = sorted(row["latencyMs"] for row in rows)[math.ceil(.95 * len(rows)) - 1]
    return values


def export_tasks(root, bindings, k, max_lines):
    manifest, tasks, _ = load_dataset(root)
    if set(bindings) != set(manifest["repositories"]):
        raise ValueError("Bindings must identify all eight repository revisions")
    if any(not b.get("repositoryId") or not b.get("analysisRevision") or "REPLACE" in json.dumps(b) for b in bindings.values()):
        raise ValueError("Replace example bindings with actual indexed repository IDs and ready revisions")
    docs = {d["id"]: d for d in manifest["documents"]}
    def label(module, relevance, lines=False):
        doc = docs[module]
        return {"repositoryId": bindings[doc["repository"]]["repositoryId"], "relativePath": doc["path"], "relevance": relevance,
                **({"startLine": 1, "endLine": doc["lines"]} if lines else {})}
    return [{"id": task["id"], "request": {"requestId": task["id"], "requirement": task["requirement"], "granularity": "function",
             "scopes": [{**b, "role": "reference"} for b in bindings.values()], "budget": {"maxFiles": k, "maxSourceLines": max_lines, "maxLatencyMs": 60000}},
             "relevant": [label(m, g) for m, g in task["relevance"].items()],
             "requiredEvidence": [label(m, 3, True) for m in task["required"]]} for task in tasks]


def run(root, k=10, max_lines=240, repeats=5, packets_path=None):
    manifest, tasks, sources = load_dataset(root)
    retriever = Retriever(manifest["documents"], sources, manifest["edges"])
    rows = []
    for variant in ["empty-context", "random", "tfidf", "bm25", "bm25-local-imports", "bm25-cross-imports"]:
        for task in tasks:
            timings = []
            for _ in range(repeats):
                start = time.perf_counter()
                selected = budget_files(retriever.rank(task["requirement"], variant), retriever.documents, k, max_lines)
                timings.append((time.perf_counter() - start) * 1000)
            rows.append({"variant": variant, "taskId": task["id"], "split": task["split"], "language": task["language"],
                         **score(task, selected, selected, k), "selected": selected, "sourceLines": sum(retriever.documents[m]["lines"] for m in selected),
                         "latencyMs": statistics.median(timings), "latencySamplesMs": timings})
    if packets_path:
        external = json.loads(Path(packets_path).read_text(encoding="utf-8"))
        if external["datasetHash"] != manifest["datasetHash"] or external["k"] != k or external["maxLines"] != max_lines:
            raise ValueError("RECAST run uses different data or budgets")
        observations = {r["taskId"]: r for r in external["observations"]}
        if set(observations) != {task["id"] for task in tasks} or len(observations) != len(external["observations"]):
            raise ValueError("RECAST run must include each task exactly once, including errors")
        for task in tasks:
            row = observations[task["id"]]
            known = set(retriever.documents)
            if not set(row["ranked"]) <= known or not set(row["covered"]) <= known:
                raise ValueError("RECAST report contains unknown document IDs")
            if row["status"] not in {"ok", "error"} or row["sourceLines"] > max_lines:
                raise ValueError("RECAST status or source budget is invalid")
            if row["status"] == "error" and (row["ranked"] or row["covered"]):
                raise ValueError("Failed tasks cannot receive retrieval credit")
            rows.append({"variant": external["variant"], "taskId": task["id"], "split": task["split"], "language": task["language"],
                         **score(task, row["ranked"][:k], row["covered"], k), "sourceLines": row["sourceLines"], "latencyMs": row["latencyMs"],
                         "status": row["status"], "error": row.get("error"), "selected": row["ranked"][:k]})
    grouped = defaultdict(list)
    for row in rows:
        grouped[(row["variant"], row["split"], row["language"])].append(row)
    return {"datasetHash": manifest["datasetHash"], "sourceRevision": manifest["sourceRevision"], "k": k, "maxLines": max_lines, "repeats": repeats,
            "documents": len(manifest["documents"]), "notes": ["file-level relevance, deduplicated results", "evidenceComplete is not behavioral or generation success", "TF-IDF is lexical, not semantic embeddings", "offline controls use complete files; RECAST may return snippets", "latencies are not directly comparable across runtimes"],
            "summary": [{"variant": v, "split": s, "language": lang, **summarize(items)} for (v, s, lang), items in grouped.items()], "observations": rows}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=DEFAULT)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--max-lines", type=int, default=240)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--packets", type=Path)
    parser.add_argument("--bindings", type=Path, help="Export tasks for npm run evaluate:guochuang")
    args = parser.parse_args()
    if not 1 <= args.k <= 100 or args.max_lines < 1 or not 1 <= args.repeats <= 100:
        parser.error("Invalid budget or repeat count")
    if args.bindings:
        result = export_tasks(args.dataset, json.loads(args.bindings.read_text(encoding="utf-8")), args.k, args.max_lines)
        output = args.output or args.dataset / "evaluation/recast-tasks.json"
    else:
        result = run(args.dataset, args.k, args.max_lines, args.repeats, args.packets)
        output = args.output or args.dataset / "evaluation/baselines.json"
    write_json(output, result)
    print(json.dumps({"output": str(output), "summary": result.get("summary", []) if isinstance(result, dict) else {"exported": len(result)}}, ensure_ascii=False, indent=2))
