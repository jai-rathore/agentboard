#!/usr/bin/env bash
# Uptime probe for filming and judging (runs from a box cron; no secrets, read-only GETs plus the read-only smoke).
# Every run: API and executor /healthz, the web home page, the pinned headline benchmark, and the keep-warm Worker's
# /status.json (must be ok and fresh). With --smoke it also runs scripts/smoke-prod.mjs (17 read-only checks).
# One line per run goes to $LOG_DIR/uptime.log; any failure also goes to $LOG_DIR/alerts.log (the "alert").
set -u
LOG_DIR="${LOG_DIR:-/workspace/agentboard-uptime}"
API="${API_URL:-https://agentboard-api.onrender.com}"
EXEC="${EXECUTOR_URL:-https://agentboard-executor.onrender.com}"
WEB="${WEB_URL:-https://agentboard-olive-pi.vercel.app}"
KW="${KEEPWARM_URL:-https://agentboard-keepwarm.jaiadityarathore.workers.dev/status.json}"
HEADLINE="${HEADLINE_BENCHMARK:-44a3528b-dc3c-4f66-a831-e41418f66aae}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$LOG_DIR"
now="$(date '+%Y-%m-%d %H:%M:%S %Z')"; fails=(); parts=()

get() { # name url -> "code secs"
  curl -s -o /tmp/uptime-body.$$ -w '%{http_code} %{time_total}' --max-time 75 "$2" 2>/dev/null || echo "000 75"
}
for pair in "api|$API/healthz" "executor|$EXEC/healthz" "web|$WEB/"; do
  n="${pair%%|*}"; u="${pair#*|}"; read -r code secs <<<"$(get "$n" "$u")"
  parts+=("$n=$code/${secs}s"); [ "$code" = 200 ] || fails+=("$n HTTP $code")
done
read -r code secs <<<"$(get headline "$API/v1/benchmarks/latest")"
id="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("id",""))' /tmp/uptime-body.$$ 2>/dev/null)"
parts+=("headline=$code/${id:0:8}"); { [ "$code" = 200 ] && [ "$id" = "$HEADLINE" ]; } || fails+=("headline HTTP $code id ${id:-none}")
read -r code secs <<<"$(get keepwarm "$KW")"
kw="$(python3 - /tmp/uptime-body.$$ <<'PY' 2>/dev/null
import json, sys, datetime as d
s = json.load(open(sys.argv[1])); t = d.datetime.fromisoformat(s["checked_at"].replace("Z", "+00:00"))
age = (d.datetime.now(d.timezone.utc) - t).total_seconds() / 60
print(("ok" if s.get("ok") else "notok") + f" {age:.0f}m")
PY
)"
parts+=("keepwarm=${kw:-unreadable}"); case "$kw" in ok\ *) age="${kw#ok }"; [ "${age%m}" -le 15 ] || fails+=("keepwarm stale $age");; *) fails+=("keepwarm ${kw:-unreadable}");; esac
rm -f /tmp/uptime-body.$$
if [ "${1:-}" = "--smoke" ]; then
  out="$(cd "$REPO" && timeout 600 node scripts/smoke-prod.mjs 2>&1)"; rc=$?
  parts+=("smoke=$(printf '%s\n' "$out" | grep -Eo '[0-9]+/[0-9]+ checks passed' | tail -1 || true) rc$rc")
  [ $rc -eq 0 ] || fails+=("smoke rc $rc: $(printf '%s\n' "$out" | grep -E '^FAIL' | head -3 | tr '\n' ' ')")
fi
if [ ${#fails[@]} -eq 0 ]; then echo "$now OK ${parts[*]}" >> "$LOG_DIR/uptime.log"
else line="$now FAIL ${fails[*]} | ${parts[*]}"; echo "$line" >> "$LOG_DIR/uptime.log"; echo "$line" >> "$LOG_DIR/alerts.log"; exit 1; fi
