#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
TMP_ROOT_RAW=$(mktemp -d /tmp/balance-native-updater-e2e.XXXXXX)
TMP_ROOT=$(CDPATH= cd -- "$TMP_ROOT_RAW" && pwd -P)
NEXT_ROOT="$TMP_ROOT/next"
SERVER_ROOT="$TMP_ROOT/server"
BASE_CONFIG="$TMP_ROOT/base-e2e-config.json"
NEXT_TARGET="$TMP_ROOT/target-next"
BASE_TARGET="$NEXT_TARGET"
SERVER_PID=""
ACTIVE_APP=""
ACTIVE_APP_PID=""
APP_LAUNCH_COUNT=0
WORKTREE_ADDED=0
HEALTH_URL="http://127.0.0.1:4780/api/desktop-health"
EXPECTED_HEALTH='{"app":"balance","mode":"desktop"}'
SIGNING_PRIVATE_KEY=${TAURI_SIGNING_PRIVATE_KEY:-"$HOME/.tauri/balance-updater.key"}

case "$TMP_ROOT" in
  /tmp/balance-native-updater-e2e.* | /private/tmp/balance-native-updater-e2e.*) ;;
  *)
    echo "Refusing unsafe updater E2E temp path: $TMP_ROOT" >&2
    exit 1
    ;;
esac

exact_pids() {
  ps -Ao pid=,command= | awk -v binary="$1" '$2 == binary { print $1 }'
}

curl_loopback() {
  curl --noproxy '*' "$@"
}

terminate_active_app() {
  if [ -z "$ACTIVE_APP" ]; then
    return
  fi
  for binary in \
    "$ACTIVE_APP/Contents/MacOS/balance-node" \
    "$ACTIVE_APP/Contents/MacOS/balance-desktop"; do
    pids=$(exact_pids "$binary")
    if [ -n "$pids" ]; then
      kill $pids >/dev/null 2>&1 || true
    fi
  done
}

cleanup() {
  status=$1
  trap - EXIT INT TERM HUP
  set +e
  terminate_active_app
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [ "$WORKTREE_ADDED" -eq 1 ]; then
    (cd "$REPO_ROOT" && git worktree remove --force "$NEXT_ROOT") >/dev/null 2>&1 || true
  fi
  rm -r "$TMP_ROOT"
  exit "$status"
}

trap 'cleanup $?' EXIT INT TERM HUP

assert_port_free() {
  port=$1
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "TCP $port is already in use" >&2
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
    exit 1
  fi
}

assert_bundle_version() {
  app_path=$1
  expected=$2
  actual=$(plutil -extract CFBundleShortVersionString raw "$app_path/Contents/Info.plist")
  if [ "$actual" != "$expected" ]; then
    echo "Expected $app_path version $expected, got $actual" >&2
    exit 1
  fi
  pack_path="$app_path/Contents/Resources/balance-server/pack.json"
  node -e '
    const pack = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const expected = process.argv[2];
    for (const key of ["packVersion", "nativeVersion", "minNativeVersion"]) {
      if (pack[key] !== expected) throw new Error(`${key}: expected ${expected}, got ${pack[key]}`);
    }
  ' "$pack_path" "$expected"
}

wait_for_health() {
  attempt=0
  while :; do
    if body=$(curl_loopback -fsS --max-time 2 "$HEALTH_URL"); then
      if [ "$body" != "$EXPECTED_HEALTH" ]; then
        echo "Unexpected desktop health response: $body" >&2
        exit 1
      fi
      printf '%s\n' "$body"
      return
    fi
    attempt=$((attempt + 1))
    if [ -n "$ACTIVE_APP_PID" ] && ! kill -0 "$ACTIVE_APP_PID" 2>/dev/null; then
      cat "$TMP_ROOT/app-$APP_LAUNCH_COUNT.err" >&2 || true
      echo "Balance updater E2E app exited before health became ready" >&2
      exit 1
    fi
    if [ "$attempt" -ge 80 ]; then
      cat "$TMP_ROOT/app-$APP_LAUNCH_COUNT.err" >&2 || true
      echo "Balance updater E2E health check timed out" >&2
      exit 1
    fi
    sleep 0.25
  done
}

start_app() {
  ACTIVE_APP=$1
  APP_LAUNCH_COUNT=$((APP_LAUNCH_COUNT + 1))
  app_binary="$ACTIVE_APP/Contents/MacOS/balance-desktop"
  sidecar_binary="$ACTIVE_APP/Contents/MacOS/balance-node"
  test -d "$ACTIVE_APP"
  codesign --verify --deep --strict "$ACTIVE_APP"
  if [ -n "$(exact_pids "$app_binary")" ] || [ -n "$(exact_pids "$sidecar_binary")" ]; then
    echo "An exact updater E2E app process is already running" >&2
    exit 1
  fi
  NO_PROXY='127.0.0.1,localhost' no_proxy='127.0.0.1,localhost' \
    HTTP_PROXY='' HTTPS_PROXY='' ALL_PROXY='' \
    http_proxy='' https_proxy='' all_proxy='' \
    HOME="$TMP_ROOT/home" CFFIXED_USER_HOME="$TMP_ROOT/home" \
    "$app_binary" \
    >"$TMP_ROOT/app-$APP_LAUNCH_COUNT.out" \
    2>"$TMP_ROOT/app-$APP_LAUNCH_COUNT.err" &
  ACTIVE_APP_PID=$!
  wait_for_health
  app_pids=$(exact_pids "$app_binary")
  app_count=$(printf '%s\n' "$app_pids" | awk 'NF { count += 1 } END { print count + 0 }')
  if [ "$app_count" -ne 1 ]; then
    echo "Expected one updater E2E app process, found: $app_pids" >&2
    exit 1
  fi
  if [ "$app_pids" != "$ACTIVE_APP_PID" ]; then
    echo "Updater E2E launched PID $ACTIVE_APP_PID but observed $app_pids" >&2
    exit 1
  fi
  lsof -nP -iTCP:4780 -sTCP:LISTEN | awk 'NR > 1 && index($0, "127.0.0.1:4780 (LISTEN)") == 0 { exit 1 }'
}

wait_for_app_exit() {
  app_binary="$ACTIVE_APP/Contents/MacOS/balance-desktop"
  sidecar_binary="$ACTIVE_APP/Contents/MacOS/balance-node"
  attempt=0
  while :; do
    health_alive=0
    curl_loopback -fsS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1 && health_alive=1
    app_pids=$(exact_pids "$app_binary")
    sidecar_pids=$(exact_pids "$sidecar_binary")
    if [ "$health_alive" -eq 0 ] && [ -z "$app_pids" ] && [ -z "$sidecar_pids" ]; then
      wait "$ACTIVE_APP_PID" >/dev/null 2>&1 || true
      ACTIVE_APP=""
      ACTIVE_APP_PID=""
      return
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 80 ]; then
      echo "Balance or its sidecar stayed alive after 退出余量" >&2
      exit 1
    fi
    sleep 0.25
  done
}

run_ui_driver() {
  mode=$1
  swift "$REPO_ROOT/scripts/macos-updater-e2e.swift" "$mode" "$ACTIVE_APP_PID"
  wait_for_app_exit
}

write_manifest() {
  signature=$1
  UPDATE_SIGNATURE="$signature" node -e '
    const { writeFileSync } = require("node:fs");
    const manifest = {
      version: "0.3.1",
      notes: "Balance native updater E2E",
      platforms: {
        "darwin-aarch64": {
          signature: process.env.UPDATE_SIGNATURE,
          url: "http://127.0.0.1:4876/Balance.app.tar.gz",
        },
      },
    };
    writeFileSync(process.argv[1], `${JSON.stringify(manifest, null, 2)}\n`);
  ' "$SERVER_ROOT/latest.json.next"
  mv "$SERVER_ROOT/latest.json.next" "$SERVER_ROOT/latest.json"
}

build_base_app() {
  (
    cd "$REPO_ROOT"
    CARGO_TARGET_DIR="$BASE_TARGET" \
      TAURI_SIGNING_PRIVATE_KEY="$SIGNING_PRIVATE_KEY" \
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
      VITE_DESKTOP_UPDATER_E2E=true \
      ./node_modules/.bin/tauri build \
        --target aarch64-apple-darwin \
        --bundles app,dmg \
        --config "$BASE_CONFIG"
  )
}

if [ ! -f "$SIGNING_PRIVATE_KEY" ]; then
  echo "Updater signing key does not exist: $SIGNING_PRIVATE_KEY" >&2
  exit 1
fi

assert_port_free 4780
assert_port_free 4876
mkdir -p "$SERVER_ROOT" "$TMP_ROOT/home"

tracked_hash_before=$(shasum \
  "$REPO_ROOT/desktop-pack.json" \
  "$REPO_ROOT/desktop-native.lock" \
  "$REPO_ROOT/src-tauri/Cargo.toml" \
  "$REPO_ROOT/src-tauri/tauri.conf.json" \
  "$REPO_ROOT/package.json")

(
  cd "$REPO_ROOT"
  git worktree add --detach "$NEXT_ROOT" HEAD
)
WORKTREE_ADDED=1
ln -s "$REPO_ROOT/node_modules" "$NEXT_ROOT/node_modules"

node --input-type=module - "$NEXT_ROOT" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const read = (relative) => readFileSync(join(root, relative), "utf8");
const write = (relative, contents) => writeFileSync(join(root, relative), contents);

const pack = JSON.parse(read("desktop-pack.json"));
pack.packVersion = "0.3.1";
pack.minNativeVersion = "0.3.1";
write("desktop-pack.json", `${JSON.stringify(pack, null, 2)}\n`);

const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
tauri.version = "0.3.1";
write("src-tauri/tauri.conf.json", `${JSON.stringify(tauri, null, 2)}\n`);

const cargo = read("src-tauri/Cargo.toml").replace(
  /^version = "0\.3\.0"$/m,
  'version = "0.3.1"',
);
if (!/^version = "0\.3\.1"$/m.test(cargo)) throw new Error("Cargo version bump failed");
write("src-tauri/Cargo.toml", cargo);

const packageJson = JSON.parse(read("package.json"));
packageJson.scripts["desktop:verify:dmg"] = packageJson.scripts["desktop:verify:dmg"].replace(
  "Balance_0.3.0_aarch64.dmg",
  "Balance_0.3.1_aarch64.dmg",
);
write("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

const moduleUrl = pathToFileURL(join(root, "scripts/prepare-desktop-pack.mjs")).href;
const { nativeFingerprint } = await import(moduleUrl);
write(
  "desktop-native.lock",
  `${JSON.stringify({ nativeVersion: "0.3.1", fingerprint: nativeFingerprint(root) }, null, 2)}\n`,
);
NODE

(
  cd "$NEXT_ROOT"
  VITE_DESKTOP_UPDATER_E2E=true npm run desktop:prepare
)

node -e '
  const pack = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  for (const key of ["packVersion", "nativeVersion", "minNativeVersion"]) {
    if (pack[key] !== "0.3.1") throw new Error(`${key} did not move to 0.3.1`);
  }
' "$NEXT_ROOT/.output/pack.json"

(
  cd "$NEXT_ROOT"
  CARGO_TARGET_DIR="$NEXT_TARGET" \
    TAURI_SIGNING_PRIVATE_KEY="$SIGNING_PRIVATE_KEY" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
    VITE_DESKTOP_UPDATER_E2E=true \
    ./node_modules/.bin/tauri build --target aarch64-apple-darwin --bundles app
)

NEXT_APP="$NEXT_TARGET/aarch64-apple-darwin/release/bundle/macos/Balance.app"
NEXT_ARCHIVE="$NEXT_TARGET/aarch64-apple-darwin/release/bundle/macos/Balance.app.tar.gz"
NEXT_SIGNATURE="$NEXT_ARCHIVE.sig"
assert_bundle_version "$NEXT_APP" "0.3.1"
codesign --verify --deep --strict "$NEXT_APP"
test -s "$NEXT_ARCHIVE"
test -s "$NEXT_SIGNATURE"
cp "$NEXT_ARCHIVE" "$SERVER_ROOT/Balance.app.tar.gz"
cp "$NEXT_SIGNATURE" "$SERVER_ROOT/Balance.app.tar.gz.sig"
valid_signature=$(cat "$NEXT_SIGNATURE")
write_manifest "$valid_signature"

node - "$BASE_CONFIG" <<'NODE'
const { writeFileSync } = require("node:fs");
writeFileSync(
  process.argv[2],
  `${JSON.stringify(
    {
      plugins: {
        updater: {
          endpoints: ["http://127.0.0.1:4876/latest.json"],
          dangerousInsecureTransportProtocol: true,
        },
      },
    },
    null,
    2,
  )}\n`,
);
NODE

python3 -m http.server 4876 --bind 127.0.0.1 --directory "$SERVER_ROOT" \
  >"$TMP_ROOT/server.out" 2>"$TMP_ROOT/server.err" &
SERVER_PID=$!
attempt=0
while ! curl_loopback -fsS --max-time 1 "http://127.0.0.1:4876/latest.json" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 40 ] || ! kill -0 "$SERVER_PID" 2>/dev/null; then
    cat "$TMP_ROOT/server.err" >&2
    echo "Updater E2E server failed to start" >&2
    exit 1
  fi
  sleep 0.25
done

build_base_app
BASE_APP="$BASE_TARGET/aarch64-apple-darwin/release/bundle/macos/Balance.app"
assert_bundle_version "$BASE_APP" "0.3.0"
start_app "$BASE_APP"
run_ui_driver install-success
assert_bundle_version "$BASE_APP" "0.3.1"
echo "native-updater-install-ok: 0.3.0 -> 0.3.1"

start_app "$BASE_APP"
run_ui_driver restart
assert_bundle_version "$BASE_APP" "0.3.1"
echo "native-updater-restart-ok: version=0.3.1 health=$EXPECTED_HEALTH"

bad_signature=$(VALID_SIGNATURE="$valid_signature" node -e '
  const decoded = Buffer.from(process.env.VALID_SIGNATURE, "base64")
    .toString("utf8")
    .split("\n");
  if (!decoded[1]) throw new Error("updater signature payload is missing");
  decoded[1] = (decoded[1][0] === "A" ? "B" : "A") + decoded[1].slice(1);
  process.stdout.write(Buffer.from(decoded.join("\n"), "utf8").toString("base64"));
')
if [ "${#bad_signature}" -ne "${#valid_signature}" ]; then
  echo "Tampered updater signature changed length" >&2
  exit 1
fi
write_manifest "$bad_signature"
build_base_app
assert_bundle_version "$BASE_APP" "0.3.0"
start_app "$BASE_APP"
run_ui_driver install-failure
assert_bundle_version "$BASE_APP" "0.3.0"
echo "native-updater-bad-signature-ok: version=0.3.0"

tracked_hash_after=$(shasum \
  "$REPO_ROOT/desktop-pack.json" \
  "$REPO_ROOT/desktop-native.lock" \
  "$REPO_ROOT/src-tauri/Cargo.toml" \
  "$REPO_ROOT/src-tauri/tauri.conf.json" \
  "$REPO_ROOT/package.json")
if [ "$tracked_hash_before" != "$tracked_hash_after" ]; then
  echo "Updater E2E modified production version or signing configuration" >&2
  exit 1
fi

echo "native-updater-e2e-ok: signed install, restart, and tampered signature rejection verified"
