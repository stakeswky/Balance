#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
APP_PATH="${1:-$REPO_ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Balance.app}"
APP_BINARY="$APP_PATH/Contents/MacOS/balance-desktop"
SIDECAR_BINARY="$APP_PATH/Contents/MacOS/balance-node"
OCCUPIER_PID=""
STARTED_APP=0

exact_pids() {
  ps -Ao pid=,command= | awk -v binary="$1" '$2 == binary { print $1 }'
}

cleanup() {
  exit_code=$1
  trap - EXIT INT TERM HUP
  set +e
  if [ "$STARTED_APP" -eq 1 ]; then
    app_pids=$(exact_pids "$APP_BINARY")
    sidecar_pids=$(exact_pids "$SIDECAR_BINARY")
    if [ -n "$app_pids$sidecar_pids" ]; then
      kill $app_pids $sidecar_pids >/dev/null 2>&1 || true
    fi
  fi
  if [ -n "$OCCUPIER_PID" ]; then
    kill "$OCCUPIER_PID" >/dev/null 2>&1 || true
    wait "$OCCUPIER_PID" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}

trap 'cleanup $?' EXIT INT TERM HUP

test -x "$APP_BINARY"
if lsof -nP -iTCP:4780 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Refusing startup-error test: TCP 4780 is already in use" >&2
  exit 1
fi
if [ -n "$(exact_pids "$APP_BINARY"; exact_pids "$SIDECAR_BINARY")" ]; then
  echo "Refusing startup-error test: exact bundle process already exists" >&2
  exit 1
fi

node --input-type=module --eval '
  import net from "node:net";
  const server = net.createServer(() => {});
  server.listen(4780, "127.0.0.1");
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
' >/dev/null 2>&1 &
OCCUPIER_PID=$!

attempt=0
until lsof -nP -a -p "$OCCUPIER_PID" -iTCP:4780 -sTCP:LISTEN >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 40 ] || ! kill -0 "$OCCUPIER_PID" 2>/dev/null; then
    echo "Could not reserve 127.0.0.1:4780 for startup-error test" >&2
    exit 1
  fi
  sleep 0.1
done

open -n "$APP_PATH"
STARTED_APP=1

attempt=0
APP_PID=""
while [ -z "$APP_PID" ]; do
  APP_PID=$(exact_pids "$APP_BINARY")
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Balance startup-error process did not appear" >&2
    exit 1
  fi
  sleep 0.25
done

swift "$REPO_ROOT/scripts/macos-ui-smoke.swift" --startup-error "$APP_PID"

sidecar_pids=$(exact_pids "$SIDECAR_BINARY")
if [ -n "$sidecar_pids" ]; then
  printf 'unexpected sidecar pids: %s\n' "$sidecar_pids" >&2
  echo "Expected no sidecar when TCP 4780 is occupied" >&2
  exit 1
fi

close_script="tell application \"System Events\" to tell first process whose unix id is $APP_PID to click button 1 of window 1"
osascript -e "$close_script"

attempt=0
while [ -n "$(exact_pids "$APP_BINARY")" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 40 ]; then
    echo "Startup-error window did not close the app" >&2
    exit 1
  fi
  sleep 0.25
done
STARTED_APP=0

if ! kill -0 "$OCCUPIER_PID" 2>/dev/null; then
  echo "Balance unexpectedly terminated the unrelated port occupier" >&2
  exit 1
fi
kill "$OCCUPIER_PID"
wait "$OCCUPIER_PID"
OCCUPIER_PID=""

attempt=0
while lsof -nP -iTCP:4780 -sTCP:LISTEN >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 40 ]; then
    echo "Startup-error test did not clean its TCP 4780 occupier" >&2
    exit 1
  fi
  sleep 0.1
done

echo "native-startup-error-cleanup-ok: failure UI rendered, no sidecar started, TCP 4780 test occupier cleaned"
