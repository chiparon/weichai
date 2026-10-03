#!/usr/bin/env bash
set -euo pipefail

# Run a plain Coding Agent baseline against an isolated copy of the target.
# The agent starts inside results/<run-id>/target-project; history repositories
# are deliberately neither copied nor added to the agent's tool directories.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
dataset_root="$repo_root/experiments/enterprise-asset-upgrade"
target_source="$dataset_root/target-project"
requirements_source="$target_source/requirements"
results_root="${BASELINE_RESULTS_ROOT:-$dataset_root/results}"
run_id="${BASELINE_RUN_ID:-baseline-$(date -u +%Y%m%dT%H%M%SZ)}"
prompt_file=""

usage() {
  cat <<'EOF'
Usage: scripts/run-enterprise-asset-upgrade-baseline.sh [options]

Options:
  --prompt-file FILE   Use an additional task prompt instead of the default.
  --run-id ID          Store this run under experiments/enterprise-asset-upgrade/results/ID.
  --help               Show this help.

Environment:
  DEEPSEEK_API_KEY     Required by scripts/run-claude-deepseek.sh.
  DEEPSEEK_MODEL       Defaults to deepseek-v4-flash, matching RECAST.
  BASELINE_RESULTS_ROOT  Override the results directory.
EOF
}

while (($#)); do
  case "$1" in
    --prompt-file)
      (($# >= 2)) || { echo "--prompt-file requires a path" >&2; exit 2; }
      prompt_file="$2"; shift 2 ;;
    --run-id)
      (($# >= 2)) || { echo "--run-id requires an id" >&2; exit 2; }
      run_id="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

run_dir="$results_root/$run_id"

[[ -d "$target_source" ]] || { echo "Target project not found: $target_source" >&2; exit 1; }
[[ -d "$requirements_source" ]] || { echo "Requirements not found: $requirements_source" >&2; exit 1; }
[[ "$run_id" != *..* && "$run_id" != /* && "$run_id" != *"/"* ]] || { echo "Invalid run id: $run_id" >&2; exit 2; }
if [[ -n "$prompt_file" ]]; then
  [[ -f "$prompt_file" ]] || { echo "Prompt file not found: $prompt_file" >&2; exit 1; }
fi

mkdir -p "$run_dir"
if [[ -e "$run_dir/target-project" || -e "$run_dir/requirements" ]]; then
  echo "Refusing to overwrite existing baseline run: $run_dir" >&2
  exit 1
fi

# cp only the target project. In particular, source-repositories is never copied
# and is not passed through --add-dir or the prompt.
cp -a "$target_source" "$run_dir/target-project"
mkdir -p "$run_dir/requirements"
cp -a "$requirements_source"/. "$run_dir/requirements/"

if [[ -n "$prompt_file" ]]; then
  cp "$prompt_file" "$run_dir/task-prompt.md"
else
  cat > "$run_dir/task-prompt.md" <<'EOF'
# Enterprise asset upgrade baseline

Implement the requested AssetUpgradeGateway target project as a plain coding-agent baseline.
Read the C# source under `target-project/` and every requirement under `requirements/`.
Implement all four requirements, update or add tests where useful, and run the target project's
available tests/build commands. Record useful implementation notes in the final response.

This is an isolated baseline run. Work only in the current target-project directory. Do not
inspect, search, index, import, or reference any parent directory, sibling directory, history
repository, source-repositories directory, or RECAST/ForeXplore implementation. Do not edit the
copied requirements. Do not modify the original dataset; the current directory is a disposable
copy created specifically for this run.
EOF
fi

cat > "$run_dir/run-manifest.json" <<EOF
{
  "runId": "${run_id}",
  "kind": "coding-agent-baseline",
  "model": "${DEEPSEEK_MODEL:-deepseek-v4-flash}",
  "workspace": "target-project",
  "requirements": "requirements",
  "historyExposed": false,
  "sourceDataset": "target-project"
}
EOF

launcher="$repo_root/scripts/run-claude-deepseek.sh"
[[ -x "$launcher" ]] || { echo "Missing executable launcher: $launcher" >&2; exit 1; }
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'Starting baseline in %s\n' "$run_dir"
printf 'Model: %s\n' "${DEEPSEEK_MODEL:-deepseek-v4-flash}"
printf 'History repositories exposed: no\n'

if [[ "${BASELINE_DRY_RUN:-0}" == "1" ]]; then
  printf '%s\n' '{"type":"dry-run","message":"Agent invocation skipped."}' | tee "$run_dir/agent-stream.jsonl"
  agent_status=0
else
  set +e
  (
    cd "$run_dir/target-project"
    # --bare prevents repository-local settings and MCP configuration from being
    # discovered. The explicit prompt is the only task context supplied here.
    "$launcher" \
      --bare \
      --no-session-persistence \
      --permission-mode bypassPermissions \
      --allow-dangerously-skip-permissions \
      --output-format stream-json \
      -p "$(cat "$run_dir/task-prompt.md")"
  ) 2>&1 | tee "$run_dir/agent-stream.jsonl"
  agent_status=${PIPESTATUS[0]}
  set -e
fi

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - "$run_dir/run-result.json" "$run_id" "$started_at" "$finished_at" "$agent_status" <<'PY'
import json, pathlib, sys
out, run_id, started, finished, status = sys.argv[1:]
root = pathlib.Path(out).parent
files = [p for p in (root / "target-project").rglob("*") if p.is_file() and ".git" not in p.parts]
result = {
    "runId": run_id,
    "kind": "coding-agent-baseline",
    "startedAt": started,
    "finishedAt": finished,
    "exitCode": int(status),
    "success": int(status) == 0,
    "workspace": str(root / "target-project"),
    "requirements": str(root / "requirements"),
    "agentLog": str(root / "agent-stream.jsonl"),
    "historyExposed": False,
    "resultFileCount": len(files),
}
pathlib.Path(out).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
PY

printf 'Baseline exit code: %s\n' "$agent_status"
printf 'Result code copy: %s\n' "$run_dir/target-project"
printf 'Agent log: %s\n' "$run_dir/agent-stream.jsonl"
printf 'Run result: %s\n' "$run_dir/run-result.json"
exit "$agent_status"
