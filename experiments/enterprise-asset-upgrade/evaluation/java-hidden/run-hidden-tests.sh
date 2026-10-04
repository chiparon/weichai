#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target_project="${1:-$script_dir/../../java-target-project}"
target_project="$(realpath "$target_project")"
maven_bin="${MAVEN_BIN:-mvn}"

if [[ -n "${JAVA_HOME:-}" ]]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi
command -v java >/dev/null || { echo "JDK 21 is required; set JAVA_HOME" >&2; exit 2; }
command -v "$maven_bin" >/dev/null 2>&1 || { echo "Maven is required; set MAVEN_BIN" >&2; exit 2; }

"$maven_bin" -q -f "$target_project/pom.xml" -DskipTests clean package
cd "$script_dir"
exec "$maven_bin" -q -Dtarget.project="$target_project" test
