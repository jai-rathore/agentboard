#!/usr/bin/env bash
# Fails if a committed generated file is stale: the MCP bundle (bin/agentboard-mcp.mjs, run by
# `npx -y github:jai-rathore/agentboard`) and the MCP server card (packages/api/static/mcp-server-card.json).
# Regenerates both in place; if either changed, commit the regenerated file. Used by CI and `pnpm verify`.
set -euo pipefail
cd "$(dirname "$0")/.."
sum() { sha256sum "$1" | cut -d' ' -f1; }
stale=0
check() { # <file> <command...>
  local file=$1; shift
  local before; before=$(sum "$file")
  "$@" >/dev/null
  if [[ "$(sum "$file")" != "$before" ]]; then
    echo "::error file=$file::$file is stale. Regenerate with: $*  (then commit it)"; stale=1
  else
    echo "ok: $file is up to date"
  fi
}
check bin/agentboard-mcp.mjs pnpm bundle:mcp
check packages/api/static/mcp-server-card.json bash -c "cd packages/api && npx tsx scripts/gen-server-card.ts"
exit $stale
