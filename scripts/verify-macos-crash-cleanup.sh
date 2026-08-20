#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
APP_PATH="${1:-$REPO_ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Balance.app}"
APP_BINARY="$APP_PATH/Contents/MacOS/synq-desktop"
SIDECAR_BINARY="$APP_PATH/Contents/MacOS/synq-node"
HEALTH_URL="http://127.0.0.1:4780/api/desktop-health"
EXPECTED_HEALTH='{"app":"synq","mode":"desktop"}'
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
  exit "$exit_code"
}

trap 'cleanup $?' EXIT INT TERM HUP

test -x "$APP_BINARY"
test -x "$SIDECAR_BINARY"
if lsof -nP -iTCP:4780 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Refusing crash cleanup test: TCP 4780 is already in use" >&2
  exit 1
fi
if [ -n "$(exact_pids "$APP_BINARY"; exact_pids "$SIDECAR_BINARY")" ]; then
  echo "Refusing crash cleanup test: exact bundle process already exists" >&2
  exit 1
fi

open -n "$APP_PATH"
STARTED_APP=1

attempt=0
while :; do
  if health_body=$(curl_loopback -fsS --max-time 2 "$HEALTH_URL") &&
     [ "$health_body" = "$EXPECTED_HEALTH" ]; then
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Crash cleanup precondition timed out" >&2
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
  echo "Expected one app pid and one exact sidecar pid" >&2
  exit 1
fi
APP_PID=$app_pids
SIDECAR_PID=$sidecar_pids
printf 'crash-precondition-ok: app pid=%s exact sidecar pid=%s\n' "$APP_PID" "$SIDECAR_PID"

# SIGKILL prevents every Tauri exit callback; only the packaged watchdog can
# close the exact sidecar pid and TCP 4780 after this point.
kill -9 "$APP_PID"

attempt=0
while :; do
  remaining_sidecar=$(exact_pids "$SIDECAR_BINARY")
  listener=$(lsof -nP -iTCP:4780 -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "$remaining_sidecar" ] && [ -z "$listener" ]; then
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 40 ]; then
    printf 'remaining exact sidecar pid(s): %s\n%s\n' "$remaining_sidecar" "$listener" >&2
    echo "Packaged watchdog left the sidecar or TCP 4780 alive" >&2
    exit 1
  fi
  sleep 0.25
done

if curl_loopback -fsS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
  echo "Desktop health remained reachable after parent SIGKILL" >&2
  exit 1
fi

STARTED_APP=0
echo "native-crash-cleanup-ok: exact sidecar pid $SIDECAR_PID exited and TCP 4780 is closed"
