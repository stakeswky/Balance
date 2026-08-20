#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
APP_PATH="${1:-$REPO_ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Balance.app}"
APP_BINARY="$APP_PATH/Contents/MacOS/synq-desktop"
SIDECAR_BINARY="$APP_PATH/Contents/MacOS/synq-node"
HEALTH_URL="http://127.0.0.1:4780/api/desktop-health"
AUTH_URL="http://127.0.0.1:4780/api/auth/get-session"
EXPECTED_HEALTH='{"app":"synq","mode":"desktop"}'
SENTINEL_MODULE="$REPO_ROOT/scripts/node-options-sentinel.cjs"
TMP_ROOT=$(mktemp -d /tmp/synq-macos-env.XXXXXX)
NODE_OPTIONS_MARKER="$TMP_ROOT/node-options-loaded"
DATABASE_MARKER="$TMP_ROOT/database-connected"
DATABASE_PORT=4799
DATABASE_PID=""
STARTED_APP=0

exact_pids() {
  ps -Ao pid=,command= | awk -v binary="$1" '$2 == binary { print $1 }'
}

curl_loopback() {
  curl --noproxy '*' "$@"
}

cleanup() {
  exit_code=$1
  trap - EXIT INT TERM HUP
  set +e
  if [ "$STARTED_APP" -eq 1 ]; then
    cleanup_pids=$(exact_pids "$SIDECAR_BINARY"; exact_pids "$APP_BINARY")
    if [ -n "$cleanup_pids" ]; then
      kill $cleanup_pids >/dev/null 2>&1 || true
    fi
  fi
  if [ -n "$DATABASE_PID" ]; then
    kill "$DATABASE_PID" >/dev/null 2>&1 || true
    wait "$DATABASE_PID" >/dev/null 2>&1 || true
  fi
  rm -r "$TMP_ROOT"
  exit "$exit_code"
}

trap 'cleanup $?' EXIT INT TERM HUP

test -x "$APP_BINARY"
test -x "$SIDECAR_BINARY"
test -f "$SENTINEL_MODULE"
for port in 4780 "$DATABASE_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Refusing environment isolation test: TCP $port is already in use" >&2
    exit 1
  fi
done
if [ -n "$(exact_pids "$APP_BINARY"; exact_pids "$SIDECAR_BINARY")" ]; then
  echo "Refusing environment isolation test: exact bundle process already exists" >&2
  exit 1
fi

node --input-type=module --eval '
  import { appendFileSync } from "node:fs";
  import net from "node:net";
  const marker = process.argv[1];
  const port = Number(process.argv[2]);
  const server = net.createServer((socket) => {
    appendFileSync(marker, "connected\n");
    socket.destroy();
  });
  server.listen(port, "127.0.0.1");
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
' "$DATABASE_MARKER" "$DATABASE_PORT" >"$TMP_ROOT/database.out" 2>"$TMP_ROOT/database.err" &
DATABASE_PID=$!

attempt=0
until lsof -nP -a -p "$DATABASE_PID" -iTCP:"$DATABASE_PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 40 ] || ! kill -0 "$DATABASE_PID" 2>/dev/null; then
    cat "$TMP_ROOT/database.err" >&2
    echo "Could not start DATABASE_URL sentinel listener" >&2
    exit 1
  fi
  sleep 0.1
done

DATABASE_URL="postgresql://synq:sentinel@127.0.0.1:$DATABASE_PORT/synq" \
BETTER_AUTH_SECRET="must-not-reach-desktop" \
GROK_AUTH_CLIENT_SECRET="must-not-reach-desktop" \
NODE_OPTIONS="--require=$SENTINEL_MODULE" \
NODE_USE_ENV_PROXY="1" \
HTTP_PROXY="http://127.0.0.1:1" \
HTTPS_PROXY="http://127.0.0.1:1" \
ALL_PROXY="http://127.0.0.1:1" \
TMPDIR="$TMP_ROOT" \
"$APP_BINARY" >"$TMP_ROOT/app.out" 2>"$TMP_ROOT/app.err" &
STARTED_APP=1

attempt=0
while :; do
  if health_body=$(curl_loopback -fsS --max-time 2 "$HEALTH_URL") &&
     [ "$health_body" = "$EXPECTED_HEALTH" ]; then
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    cat "$TMP_ROOT/app.err" >&2
    echo "Environment-isolated desktop health check timed out" >&2
    exit 1
  fi
  sleep 0.25
done

app_pids=$(exact_pids "$APP_BINARY")
sidecar_pids=$(exact_pids "$SIDECAR_BINARY")
app_count=$(printf '%s\n' "$app_pids" | awk 'NF { count += 1 } END { print count + 0 }')
sidecar_count=$(printf '%s\n' "$sidecar_pids" | awk 'NF { count += 1 } END { print count + 0 }')
if [ "$app_count" -ne 1 ] || [ "$sidecar_count" -ne 1 ]; then
  printf 'app pids: %s\nsidecar pids: %s\n' "$app_pids" "$sidecar_pids" >&2
  echo "Expected one app pid and one sidecar pid" >&2
  exit 1
fi
APP_PID=$app_pids

auth_status=$(curl_loopback -sS --max-time 5 -o "$TMP_ROOT/auth.body" -w '%{http_code}' "$AUTH_URL")
if [ "$auth_status" != "404" ]; then
  cat "$TMP_ROOT/auth.body" >&2
  echo "Expected desktop auth endpoint HTTP 404, got HTTP $auth_status" >&2
  exit 1
fi

sleep 1
if [ -e "$NODE_OPTIONS_MARKER" ]; then
  cat "$NODE_OPTIONS_MARKER" >&2
  echo "NODE_OPTIONS sentinel loaded inside the desktop sidecar" >&2
  exit 1
fi
if [ -e "$DATABASE_MARKER" ]; then
  cat "$DATABASE_MARKER" >&2
  echo "DATABASE_URL sentinel received a desktop connection" >&2
  exit 1
fi

kill "$APP_PID"
attempt=0
while :; do
  remaining_app=$(exact_pids "$APP_BINARY")
  remaining_sidecar=$(exact_pids "$SIDECAR_BINARY")
  listener=$(lsof -nP -iTCP:4780 -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "$remaining_app" ] && [ -z "$remaining_sidecar" ] && [ -z "$listener" ]; then
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 40 ]; then
    printf 'remaining app: %s\nremaining sidecar: %s\n%s\n' "$remaining_app" "$remaining_sidecar" "$listener" >&2
    echo "Environment isolation test left app, sidecar, or TCP 4780 alive" >&2
    exit 1
  fi
  sleep 0.25
done
STARTED_APP=0

kill "$DATABASE_PID"
wait "$DATABASE_PID"
DATABASE_PID=""

echo "desktop-env-isolation-ok: health exact; auth HTTP 404; NODE_OPTIONS sentinel not loaded; DATABASE_URL sentinel untouched; app and sidecar exited; TCP 4780 closed"
