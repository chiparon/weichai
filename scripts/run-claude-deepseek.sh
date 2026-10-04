#!/usr/bin/env bash
set -euo pipefail

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code is not installed or is not on PATH." >&2
  exit 127
fi

: "${DEEPSEEK_API_KEY:?Set DEEPSEEK_API_KEY before starting Claude Code.}"

model="${CLAUDE_CODE_MODEL:-claude-sonnet-4-6[1m]}"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"
export ANTHROPIC_MODEL="$model"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$model"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$model"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$model"
export CLAUDE_CODE_SUBAGENT_MODEL="$model"
export CLAUDE_CODE_EFFORT_LEVEL="${CLAUDE_CODE_EFFORT_LEVEL:-max}"
export CLAUDE_CODE_AUTO_COMPACT_WINDOW="${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-786432}"

# Claude Code may prefer a model stored in its local settings over
# ANTHROPIC_MODEL. Pass the DeepSeek mapped alias explicitly unless the caller
# supplied another --model/-m value.
has_model=0
for arg in "$@"; do
  case "$arg" in
    --model|-m|--model=*) has_model=1; break ;;
  esac
done
if ((has_model)); then
  exec claude --setting-sources project,local "$@"
else
  exec claude --setting-sources project,local --model "$model" "$@"
fi
