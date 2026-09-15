#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
extension_root="$repo_root/apps/vscode-extension"
compose_file="$repo_root/services/retrieval-service/docker-compose.yml"
log_dir="${TMPDIR:-/tmp}/recast-services"
skip_seekdb=false

for argument in "$@"; do
  case "$argument" in
    --skip-seek-db|--skip-seekdb)
      skip_seekdb=true
      ;;
    *)
      printf 'Unknown option: %s\nUsage: %s [--skip-seek-db]\n' "$argument" "$0" >&2
      exit 2
      ;;
  esac
done

cd "$repo_root"

if ! command -v code >/dev/null 2>&1; then
  printf 'VS Code CLI command "code" is required.\n' >&2
  exit 1
fi

if ! code --list-extensions 2>/dev/null | tr '[:upper:]' '[:lower:]' | grep -Fxq 'redhat.java'; then
  printf 'Installing required VS Code extension: redhat.java\n'
  code --install-extension redhat.java
fi

if [[ "$skip_seekdb" != true ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    printf 'Docker is required unless --skip-seek-db is used.\n' >&2
    exit 1
  fi
  docker compose -f "$compose_file" up -d
fi

# The current extension owns the code-intelligence runtime. It uses
# code-indexer -> code-intelligence-service -> SeekDB and does not need the
# legacy retrieval-service process on port 8787.
export CODE_INTELLIGENCE_SEEKDB_DATABASE="${CODE_INTELLIGENCE_SEEKDB_DATABASE:-forexplore_code_intelligence}"
export ADAPTATION_SEMANTIC_INDEX_ENABLED=true
export SEMANTIC_QUERY_PORT_URL="${SEMANTIC_QUERY_PORT_URL:-http://127.0.0.1:8790}"

npm run build:extension

mkdir -p "$log_dir"
if ! curl --fail --silent --show-error --max-time 2 \
  "${ADAPTATION_API_URL:-http://127.0.0.1:8788}/health" >/dev/null 2>&1; then
  nohup npm run dev:adaptation >"$log_dir/adaptation.log" 2>&1 &
  adaptation_pid=$!
  printf 'Started adaptation service (pid %s); log: %s\n' "$adaptation_pid" "$log_dir/adaptation.log"

  ready=false
  for _ in $(seq 1 30); do
    if curl --fail --silent --show-error --max-time 2 \
      "${ADAPTATION_API_URL:-http://127.0.0.1:8788}/health" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then
    printf 'Adaptation service did not become ready.\n' >&2
    tail -n 40 "$log_dir/adaptation.log" >&2 || true
    exit 1
  fi
else
  printf 'Using existing adaptation service at %s\n' "${ADAPTATION_API_URL:-http://127.0.0.1:8788}"
fi

exec code "--extensionDevelopmentPath=$extension_root"
