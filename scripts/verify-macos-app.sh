#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
APP_PATH="${1:-$REPO_ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Balance.app}"
SCREENSHOT_PATH="${2:-$REPO_ROOT/screenshots/synq-macos-app.png}"
BROWSER_SCREENSHOT_PATH="${3:-$REPO_ROOT/screenshots/browser-smoke.png}"
APP_BINARY="$APP_PATH/Contents/MacOS/synq-desktop"
SIDECAR_BINARY="$APP_PATH/Contents/MacOS/synq-node"
SERVER_ENTRY="$APP_PATH/Contents/Resources/synq-server/server/index.mjs"
HEALTH_URL="http://127.0.0.1:4780/api/desktop-health"
EXPECTED_HEALTH='{"app":"synq","mode":"desktop"}'
STARTED_APP=0
APP_PID=""
TMP_ROOT=$(mktemp -d /tmp/synq-macos-verify.XXXXXX)

exact_pids() {
  ps -Ao pid=,command= | awk -v binary="$1" '$2 == binary { print $1 }'
}

curl_loopback() {
  curl --noproxy '*' "$@"
}

browser_smoke() {
  NO_PROXY='*' no_proxy='*' \
    HTTP_PROXY='' HTTPS_PROXY='' ALL_PROXY='' \
    http_proxy='' https_proxy='' all_proxy='' \
    node "$REPO_ROOT/scripts/browser-smoke.mjs" "$@"
}

run_timeout() {
  timeout_seconds=$1
  stdout_path=$2
  stderr_path=$3
  shift 3
  "$@" >"$stdout_path" 2>"$stderr_path" &
  timeout_pid=$!
  timeout_ticks=0
  while kill -0 "$timeout_pid" 2>/dev/null; do
    timeout_ticks=$((timeout_ticks + 1))
    if [ "$timeout_ticks" -ge $((timeout_seconds * 4)) ]; then
      kill "$timeout_pid" 2>/dev/null || true
      wait "$timeout_pid" 2>/dev/null || true
      return 124
    fi
    sleep 0.25
  done
  wait "$timeout_pid"
}

terminate_exact_processes() {
  for binary_path in "$SIDECAR_BINARY" "$APP_BINARY"; do
    process_pids=$(exact_pids "$binary_path")
    if [ -n "$process_pids" ]; then
      printf '%s\n' "cleanup: terminating $binary_path pids: $process_pids" >&2
      kill $process_pids >/dev/null 2>&1 || true
    fi
  done
}

cleanup() {
  status=$1
  trap - EXIT INT TERM HUP
  set +e
  if [ "$STARTED_APP" -eq 1 ]; then
    terminate_exact_processes
  fi
  rm -r "$TMP_ROOT"
  exit "$status"
}

trap 'cleanup $?' EXIT INT TERM HUP

mkdir -p "$(dirname "$SCREENSHOT_PATH")" "$(dirname "$BROWSER_SCREENSHOT_PATH")"

if [ -n "${BALANCE_EXPECTED_SETTINGS:-}" ] && [ ! -f "$BALANCE_EXPECTED_SETTINGS" ]; then
  echo "Balance persistence snapshot does not exist: $BALANCE_EXPECTED_SETTINGS" >&2
  exit 1
fi

assert_arm64_binary() {
  binary_path=$1
  file_output=$(file "$binary_path")
  printf '%s\n' "$file_output"
  if [ "$file_output" != "$binary_path: Mach-O 64-bit executable arm64" ]; then
    echo "Expected an arm64-only Mach-O executable: $binary_path" >&2
    exit 1
  fi
}

if listen_output=$(lsof -nP -iTCP:4780 -sTCP:LISTEN 2>&1); then
  printf '%s\n' "$listen_output" >&2
  echo "Refusing to launch Balance: TCP 4780 is already in use" >&2
  exit 1
fi

for binary_path in "$SIDECAR_BINARY" "$APP_BINARY"; do
  existing_pids=$(exact_pids "$binary_path")
  if [ -n "$existing_pids" ]; then
    printf '%s\n' "$existing_pids" >&2
    echo "Refusing to launch Balance: an exact bundle process is already running" >&2
    exit 1
  fi
done

test -d "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
assert_arm64_binary "$APP_BINARY"
assert_arm64_binary "$SIDECAR_BINARY"
test -f "$SERVER_ENTRY"
test "$(plutil -extract NSAppTransportSecurity.NSAllowsLocalNetworking raw "$APP_PATH/Contents/Info.plist")" = "true"

open -n "$APP_PATH"
STARTED_APP=1

attempt=0
while :; do
  if health_body=$(curl_loopback -fsS --max-time 2 "$HEALTH_URL"); then
    printf '%s\n' "$health_body"
    if [ "$health_body" != "$EXPECTED_HEALTH" ]; then
      echo "Unexpected Balance desktop health response" >&2
      exit 1
    fi
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Balance desktop health check timed out" >&2
    exit 1
  fi
  sleep 0.25
done

app_pids=$(exact_pids "$APP_BINARY")
app_count=$(printf '%s\n' "$app_pids" | awk 'NF { count += 1 } END { print count + 0 }')
if [ "$app_count" -ne 1 ]; then
  printf '%s\n' "$app_pids" >&2
  echo "Expected exactly one Balance desktop process" >&2
  exit 1
fi
APP_PID=$app_pids

listen_output=$(lsof -nP -iTCP:4780 -sTCP:LISTEN)
printf '%s\n' "$listen_output"
listen_count=$(printf '%s\n' "$listen_output" | awk 'NR > 1 { count += 1 } END { print count + 0 }')
if [ "$listen_count" -ne 1 ]; then
  echo "Expected exactly one loopback-only listener on TCP 4780" >&2
  exit 1
fi
printf '%s\n' "$listen_output" | awk 'NR > 1 && index($0, "127.0.0.1:4780 (LISTEN)") == 0 { exit 1 }'
if printf '%s\n' "$listen_output" | grep -E 'TCP (\*|0\.0\.0\.0|\[::\]):4780' >/dev/null; then
  echo "Balance desktop server is not loopback-only" >&2
  exit 1
fi

ui_stdout="$TMP_ROOT/native-ui.out"
ui_stderr="$TMP_ROOT/native-ui.err"
set +e
run_timeout 45 "$ui_stdout" "$ui_stderr" swift "$REPO_ROOT/scripts/macos-ui-smoke.swift" "$APP_PID"
ui_status=$?
set -e
if [ "$ui_status" -ne 0 ]; then
  cat "$ui_stderr" >&2
  echo "Balance native UI smoke failed or timed out (status $ui_status)" >&2
  exit 1
fi
cat "$ui_stderr" >&2
if [ -n "${BALANCE_EXPECTED_SETTINGS:-}" ] && ! grep -Fx "native-persistence-ok" "$ui_stderr" >/dev/null; then
  echo "Balance native UI did not confirm the persisted settings" >&2
  exit 1
fi
ui_output=$(cat "$ui_stdout")
printf '%s\n' "$ui_output"

tab=$(printf '\t')
old_ifs=$IFS
IFS=$tab
set -- $ui_output
IFS=$old_ifs
if [ "$#" -ne 8 ] || [ "$1" != "native-ui-ok" ] || [ "$2" != "ax" ]; then
  echo "Unexpected native UI smoke output: $ui_output" >&2
  exit 1
fi
ui_title=$3
ui_x=$4
ui_y=$5
ui_width=$6
ui_height=$7
ui_window_id=$8
for value in "$ui_x" "$ui_y" "$ui_width" "$ui_height" "$ui_window_id"; do
  case "$value" in
    ''|*[!0-9-]*)
      echo "Native UI smoke returned non-numeric window bounds: $ui_output" >&2
      exit 1
      ;;
  esac
done
if [ "$ui_title" != "Balance" ] || [ "$ui_width" -lt 960 ] || [ "$ui_height" -lt 680 ]; then
  echo "Native UI smoke returned unexpected window evidence: $ui_output" >&2
  exit 1
fi

screencapture -x -o -l "$ui_window_id" "$SCREENSHOT_PATH"

set +e
if [ "$BROWSER_SCREENSHOT_PATH" = "$REPO_ROOT/screenshots/browser-smoke.png" ]; then
  browser_output=$(browser_smoke "http://127.0.0.1:4780/" 2>&1)
else
  browser_output=$(browser_smoke "http://127.0.0.1:4780/" "$BROWSER_SCREENSHOT_PATH" 2>&1)
fi
browser_status=$?
set -e
printf '%s\n' "$browser_output"
if [ "$browser_status" -ne 0 ]; then
  exit "$browser_status"
fi

close_stdout="$TMP_ROOT/close.out"
close_stderr="$TMP_ROOT/close.err"
close_script="tell application \"System Events\" to tell first process whose unix id is $APP_PID to click button 1 of window 1"
set +e
run_timeout 10 "$close_stdout" "$close_stderr" osascript -e "$close_script"
close_status=$?
set -e
if [ "$close_status" -ne 0 ]; then
  cat "$close_stderr" >&2
  echo "Balance native close action failed or timed out (status $close_status)" >&2
  exit 1
fi
cat "$close_stderr" >&2

attempt=0
while :; do
  health_alive=0
  curl_loopback -fsS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1 && health_alive=1
  remaining_app=$(exact_pids "$APP_BINARY")
  remaining_sidecar=$(exact_pids "$SIDECAR_BINARY")
  if [ "$health_alive" -eq 0 ] && [ -z "$remaining_app" ] && [ -z "$remaining_sidecar" ]; then
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 40 ]; then
    printf 'remaining app pids: %s\nremaining sidecar pids: %s\n' "$remaining_app" "$remaining_sidecar" >&2
    echo "Balance app or sidecar remained alive after native window close" >&2
    exit 1
  fi
  sleep 0.25
done

STARTED_APP=0
echo "native-close-ok: app and sidecar exited; TCP 4780 is closed"
