#!/usr/bin/env bash
# `pnpm verify`: what CI (.github/workflows/ci.yml) runs, locally. Stops at the first failure.
#   VERIFY_SKIP_WEB=1   skip the Playwright web smoke (needs `pnpm exec playwright install chromium` once)
#   TEST_DATABASE_URL   also run every suite against real Postgres 17 + pgvector (see `pnpm pg:start`)
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
step "typecheck";                 pnpm typecheck
step "unit + integration (PGlite)"; pnpm test
if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  step "unit + integration (Postgres: $(echo "$TEST_DATABASE_URL" | sed -E 's#//[^@]*@#//***@#'))"; pnpm test
else
  echo "(skipping the Postgres run: set TEST_DATABASE_URL or run 'pnpm pg:start' and use 'pnpm test:pg')"
fi
step "generated files are fresh (MCP bundle, server card)"; scripts/check-generated.sh
step "web build";                 pnpm --filter @agentboard/web run build
step "e2e (API process on PGlite, stdio + remote MCP, A2A, discovery)"; pnpm test:e2e
if [[ "${VERIFY_SKIP_WEB:-}" != "1" ]]; then step "web smoke (Playwright)"; pnpm test:web; fi
if command -v gitleaks >/dev/null; then step "gitleaks"; gitleaks git --redact --no-banner .; else echo "(gitleaks not installed: skipping the secret scan CI runs)"; fi
printf '\n\033[1;32mverify: all green\033[0m\n'
