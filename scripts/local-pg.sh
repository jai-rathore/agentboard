#!/usr/bin/env bash
# Run a throwaway local Postgres 17 + pgvector without root, for tests:
#   scripts/local-pg.sh start   -> prints TEST_DATABASE_URL
#   scripts/local-pg.sh stop
# Binaries are extracted (dpkg -x) from Debian trixie packages into $PG_HOME; nothing is installed system-wide.
set -euo pipefail
PG_HOME="${PG_HOME:-/workspace/.local-pg}"
PORT="${PG_PORT:-54329}"
BIN="$PG_HOME/usr/lib/postgresql/17/bin"
export LD_LIBRARY_PATH="$PG_HOME/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fetch() {
  local mirror=http://deb.debian.org/debian
  mkdir -p "$PG_HOME/debs" && cd "$PG_HOME/debs"
  for f in pool/main/p/postgresql-17/postgresql-17_17.11-0+deb13u1_amd64.deb \
           pool/main/p/pgvector/postgresql-17-pgvector_0.8.0-1_amd64.deb \
           pool/main/p/postgresql-17/libpq5_17.11-0+deb13u1_amd64.deb \
           pool/main/p/postgresql-17/postgresql-client-17_17.11-0+deb13u1_amd64.deb; do
    [ -f "$(basename "$f")" ] || curl -fsSL -o "$(basename "$f")" "$mirror/$f"
    dpkg -x "$(basename "$f")" "$PG_HOME"
  done
}
case "${1:-start}" in
  start)
    [ -x "$BIN/postgres" ] || fetch
    [ -d "$PG_HOME/data" ] || "$BIN/initdb" -D "$PG_HOME/data" -U agentboard --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
    "$BIN/pg_ctl" -D "$PG_HOME/data" status >/dev/null 2>&1 || "$BIN/pg_ctl" -D "$PG_HOME/data" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$PG_HOME/pg.log" start >/dev/null
    echo "TEST_DATABASE_URL=postgres://agentboard@127.0.0.1:$PORT/postgres"
    ;;
  stop) "$BIN/pg_ctl" -D "$PG_HOME/data" stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
