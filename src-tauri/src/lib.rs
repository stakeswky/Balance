use std::{
    ffi::{OsStr, OsString},
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use tauri::menu::{MenuBuilder, MenuEvent, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const SIDECAR_BIN: &str = "balance-node";
const SIDECAR_HOST: &str = "127.0.0.1";
const SIDECAR_PORT: u16 = 4780;
const NATIVE_VERSION: &str = env!("CARGO_PKG_VERSION");
const HEALTH_BODY: &str = "{\"app\":\"balance\",\"mode\":\"desktop\"}";
const SIDECAR_ENV_ALLOWLIST: [&str; 6] = [
    "HOME",
    "GROK_HOME",
    "CODEX_HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
];

fn filtered_sidecar_environment(
    environment: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    environment
        .into_iter()
        .filter(|(key, _)| {
            SIDECAR_ENV_ALLOWLIST
                .iter()
                .any(|allowed| key == OsStr::new(allowed))
        })
        .collect()
}

struct LifecycleState<T> {
    child: Option<T>,
    stopping: bool,
}

impl<T> Default for LifecycleState<T> {
    fn default() -> Self {
        Self {
            child: None,
            stopping: false,
        }
    }
}

fn install_spawned_child<T>(state: &Mutex<LifecycleState<T>>, child: T) -> Result<(), T> {
    let mut lifecycle = state.lock().expect("lifecycle mutex poisoned");
    if lifecycle.stopping {
        Err(child)
    } else {
        lifecycle.child = Some(child);
        Ok(())
    }
}

fn stop_lifecycle<T>(state: &Mutex<LifecycleState<T>>) -> Option<T> {
    let mut lifecycle = state.lock().expect("lifecycle mutex poisoned");
    lifecycle.stopping = true;
    lifecycle.child.take()
}

fn take_child_for_retry<T>(state: &Mutex<LifecycleState<T>>) -> Option<T> {
    // Overlay fallback must not set stopping; stop_lifecycle would reject the bundled retry.
    state.lock().expect("lifecycle mutex poisoned").child.take()
}

fn clear_lifecycle_child<T>(state: &Mutex<LifecycleState<T>>) {
    let _ = state.lock().expect("lifecycle mutex poisoned").child.take();
}

fn lifecycle_is_stopping<T>(state: &Mutex<LifecycleState<T>>) -> bool {
    state.lock().expect("lifecycle mutex poisoned").stopping
}

#[derive(Clone)]
struct SidecarState(Arc<Mutex<LifecycleState<CommandChild>>>);

impl Default for SidecarState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(LifecycleState::default())))
    }
}

#[derive(Clone, Default)]
struct BootstrapState(Arc<AtomicBool>);

fn sidecar_url() -> String {
    format!("http://{SIDECAR_HOST}:{SIDECAR_PORT}")
}

fn claim_bootstrap(state: &BootstrapState) -> bool {
    !state.0.swap(true, Ordering::SeqCst)
}

fn stop_sidecar(state: &SidecarState) {
    if let Some(child) = stop_lifecycle(&state.0) {
        let _ = child.kill();
    }
}

fn kill_sidecar_for_retry(state: &SidecarState) {
    if let Some(child) = take_child_for_retry(&state.0) {
        let _ = child.kill();
    }
}

fn clear_sidecar(state: &SidecarState) {
    clear_lifecycle_child(&state.0);
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn quit_app(app: &AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        stop_sidecar(&state);
    }
    app.exit(0);
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "show" => show_main_window(app),
        "quit-app" => quit_app(app),
        _ => {}
    }
}

fn install_desktop_shell(app: &AppHandle) -> tauri::Result<()> {
    let app_menu = SubmenuBuilder::new(app, "余量")
        .about(None)
        .separator()
        .text("show", "打开主窗口")
        .separator()
        .hide_with_text("隐藏余量")
        .hide_others()
        .show_all()
        .separator()
        .text("quit-app", "退出余量")
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "窗口")
        .minimize()
        .separator()
        .close_window()
        .build()?;
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(handle_menu_event);

    let tray_menu = MenuBuilder::new(app)
        .text("show", "打开余量")
        .separator()
        .text("quit-app", "退出")
        .build()?;
    if let Some(icon) = app.default_window_icon() {
        TrayIconBuilder::with_id("balance-tray")
            .icon(icon.clone())
            .menu(&tray_menu)
            .tooltip("余量 / Balance")
            .show_menu_on_left_click(false)
            .on_menu_event(handle_menu_event)
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main_window(tray.app_handle());
                }
            })
            .build(app)?;
    } else {
        eprintln!("Balance menu bar icon is missing; continuing without a tray extra");
    }
    Ok(())
}

fn ensure_port_available() -> Result<(), String> {
    TcpListener::bind((SIDECAR_HOST, SIDECAR_PORT))
        .map(|listener| drop(listener))
        .map_err(|error| format!("{SIDECAR_HOST}:{SIDECAR_PORT} is unavailable: {error}"))
}

fn wait_for_port_free(timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if ensure_port_available().is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "{SIDECAR_HOST}:{SIDECAR_PORT} did not become free in time"
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn overlay_current_dir(home: &Path) -> PathBuf {
    home.join("Library/Application Support/Balance/hot-update/current")
}

fn overlay_from_home() -> Option<PathBuf> {
    let home = match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => home,
        _ => return None,
    };
    Some(overlay_current_dir(Path::new(&home)))
}

fn json_string_field(text: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let mut search_at = 0;
    while search_at < text.len() {
        let Some(rel) = text[search_at..].find(&needle) else {
            return None;
        };
        let after_key = &text[search_at + rel + needle.len()..];
        if let Some(after_colon) = after_key.trim_start().strip_prefix(':') {
            if let Some(after_quote) = after_colon.trim_start().strip_prefix('"') {
                let mut escaped = false;
                for (index, ch) in after_quote.char_indices() {
                    if escaped {
                        escaped = false;
                        continue;
                    }
                    if ch == '\\' {
                        escaped = true;
                        continue;
                    }
                    if ch == '"' {
                        return Some(after_quote[..index].to_owned());
                    }
                }
            }
        }
        search_at += rel + 1;
    }
    None
}

fn parse_semver(version: &str) -> Option<[u64; 3]> {
    let mut parsed = [0_u64; 3];
    let mut count = 0;
    for part in version.split('.') {
        if count == 3 || part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        parsed[count] = match part.parse() {
            Ok(value) => value,
            Err(_) => return None,
        };
        count += 1;
    }
    if count != 3 {
        return None;
    }
    Some(parsed)
}

fn overlay_is_usable(
    overlay: &Path,
    native_version: &str,
    bundled_pack_version: Option<&str>,
) -> bool {
    if !overlay.join("server").join("index.mjs").is_file() {
        return false;
    }
    if !overlay.join("public").exists() {
        return false;
    }
    let text = match std::fs::read_to_string(overlay.join("pack.json")) {
        Ok(text) => text,
        Err(_) => return false,
    };
    let Some(min_native) = json_string_field(&text, "minNativeVersion") else {
        return false;
    };
    let Some(local) = parse_semver(native_version) else {
        return false;
    };
    let Some(required) = parse_semver(&min_native) else {
        return false;
    };
    if local < required {
        return false;
    }
    if let Some(bundled) = bundled_pack_version {
        if let Some(bundled_ver) = parse_semver(bundled) {
            let Some(overlay_pack) = json_string_field(&text, "packVersion") else {
                return false;
            };
            let Some(overlay_ver) = parse_semver(&overlay_pack) else {
                return false;
            };
            if overlay_ver < bundled_ver {
                return false;
            }
        }
    }
    true
}

fn bundled_pack_version(bundled: &Path) -> Option<String> {
    let text = match std::fs::read_to_string(bundled.join("pack.json")) {
        Ok(text) => text,
        Err(_) => return None,
    };
    json_string_field(&text, "packVersion")
}

fn select_server_root(bundled: PathBuf, overlay: PathBuf, native_version: &str) -> (PathBuf, bool) {
    let bundled_version = bundled_pack_version(&bundled);
    if overlay_is_usable(&overlay, native_version, bundled_version.as_deref()) {
        (overlay, true)
    } else {
        (bundled, false)
    }
}

fn quarantine_overlay(overlay: &Path, stamp: u64) -> Result<(), String> {
    if !overlay.exists() {
        return Ok(());
    }
    let parent = match overlay.parent() {
        Some(parent) => parent,
        None => return Err("missing parent".to_owned()),
    };
    let dest = parent.join(format!("failed-{stamp}"));
    std::fs::rename(overlay, dest).map_err(|error| error.to_string())
}

fn decode_chunked_body(mut body: &str) -> Option<String> {
    let mut decoded = String::new();
    loop {
        let (size_line, rest) = body.split_once("\r\n")?;
        let size_text = size_line.split(';').next()?.trim();
        let size = usize::from_str_radix(size_text, 16).ok()?;
        body = rest;
        if size == 0 {
            return Some(decoded);
        }
        if body.len() < size + 2 || !body.is_char_boundary(size) {
            return None;
        }
        let (chunk, rest) = body.split_at(size);
        if !rest.starts_with("\r\n") {
            return None;
        }
        decoded.push_str(chunk);
        body = &rest[2..];
    }
}

fn is_desktop_health_response(response: &str) -> bool {
    let Some((head, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let ok = head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200");
    if !ok {
        return false;
    }
    let chunked = head
        .lines()
        .any(|line| line.eq_ignore_ascii_case("transfer-encoding: chunked"));
    let decoded = if chunked {
        decode_chunked_body(body)
    } else {
        Some(body.trim().to_owned())
    };
    decoded.as_deref() == Some(HEALTH_BODY)
}

fn request_health() -> Result<bool, String> {
    let addr: SocketAddr = format!("{SIDECAR_HOST}:{SIDECAR_PORT}")
        .parse()
        .map_err(|error: std::net::AddrParseError| error.to_string())?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(
            b"GET /api/desktop-health HTTP/1.1\r\nHost: 127.0.0.1:4780\r\nConnection: close\r\n\r\n",
        )
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    Ok(is_desktop_health_response(&response))
}

fn wait_for_health(timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if request_health().unwrap_or(false) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err("timed out waiting for the Balance desktop server".to_owned())
}

fn resolve_server_layout(
    app: &AppHandle,
    force_bundled: bool,
) -> Result<(PathBuf, PathBuf, PathBuf, bool), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let bundled = resource_dir.join("balance-server");
    let watchdog = resource_dir.join("sidecar-watchdog.cjs");
    if !watchdog.is_file() {
        return Err(format!(
            "desktop sidecar watchdog is missing: {}",
            watchdog.display()
        ));
    }
    let (root, used_overlay) = if force_bundled {
        (bundled, false)
    } else if let Some(overlay) = overlay_from_home() {
        select_server_root(bundled, overlay, NATIVE_VERSION)
    } else {
        (bundled, false)
    };
    let entry = root.join("server").join("index.mjs");
    if !entry.is_file() {
        return Err(format!(
            "desktop server entry is missing: {}",
            entry.display()
        ));
    }
    Ok((root, entry, watchdog, used_overlay))
}

fn drain_sidecar_events(
    mut receiver: tauri::async_runtime::Receiver<CommandEvent>,
    state: SidecarState,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    eprintln!("[balance-node][stdout] {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("[balance-node][stderr] {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Error(error) => {
                    eprintln!("[balance-node][error] {error}");
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!(
                        "[balance-node] terminated: code={:?}, signal={:?}",
                        payload.code, payload.signal
                    );
                    clear_sidecar(&state);
                    break;
                }
                _ => {}
            }
        }
    });
}

fn start_sidecar(
    app: &AppHandle,
    state: &SidecarState,
    force_bundled: bool,
) -> Result<Option<bool>, String> {
    ensure_port_available()?;
    let (server_root, server_entry, watchdog, used_overlay) =
        resolve_server_layout(app, force_bundled)?;
    let inherited_environment = filtered_sidecar_environment(std::env::vars_os());
    let (receiver, child) = app
        .shell()
        .sidecar(SIDECAR_BIN)
        .map_err(|error| error.to_string())?
        .arg("--require")
        .arg(watchdog)
        .arg(server_entry)
        .current_dir(server_root)
        .env_clear()
        .envs(inherited_environment)
        .env("HOST", SIDECAR_HOST)
        .env("NITRO_HOST", SIDECAR_HOST)
        .env("PORT", SIDECAR_PORT.to_string())
        .env("NITRO_PORT", SIDECAR_PORT.to_string())
        .env("BALANCE_DESKTOP", "1")
        .env("BALANCE_PARENT_PID", std::process::id().to_string())
        .env("BALANCE_NATIVE_VERSION", NATIVE_VERSION)
        .env("VITE_AUTH_ENABLED", "false")
        .env("NODE_ENV", "production")
        .spawn()
        .map_err(|error| error.to_string())?;
    if let Err(child) = install_spawned_child(&state.0, child) {
        child
            .kill()
            .map_err(|error| format!("failed to stop sidecar during shutdown: {error}"))?;
        return Ok(None);
    }
    drain_sidecar_events(receiver, state.clone());
    Ok(Some(used_overlay))
}

fn open_window(app: &AppHandle, label: &'static str, url: WebviewUrl) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Err(error) = WebviewWindowBuilder::new(&handle, label, url)
            .title("Balance")
            .inner_size(1440.0, 960.0)
            .min_inner_size(960.0, 680.0)
            .center()
            .resizable(true)
            .build()
        {
            eprintln!("failed to create Balance window: {error}");
            handle.exit(1);
        }
    }) {
        eprintln!("failed to schedule Balance window creation: {error}");
        app.exit(1);
    }
}

fn open_main_window(app: &AppHandle) {
    let url = sidecar_url()
        .parse()
        .expect("the fixed Balance loopback URL must parse");
    open_window(app, "main", WebviewUrl::External(url));
}

fn open_startup_error(app: &AppHandle, state: &SidecarState) {
    stop_sidecar(state);
    open_window(
        app,
        "startup-error",
        WebviewUrl::App("startup-error.html".into()),
    );
}

fn bootstrap(app: AppHandle, state: SidecarState) {
    let used_overlay = match start_sidecar(&app, &state, false) {
        Ok(Some(used_overlay)) => used_overlay,
        Ok(None) => return,
        Err(error) => {
            if lifecycle_is_stopping(&state.0) {
                return;
            }
            eprintln!("desktop bootstrap failed: {error}");
            open_startup_error(&app, &state);
            return;
        }
    };
    match wait_for_health(Duration::from_secs(15)) {
        Ok(()) => {
            if lifecycle_is_stopping(&state.0) {
                return;
            }
            open_main_window(&app);
        }
        Err(error) => {
            if lifecycle_is_stopping(&state.0) {
                return;
            }
            if used_overlay {
                kill_sidecar_for_retry(&state);
                let _ = wait_for_port_free(Duration::from_secs(2));
                if let Some(overlay) = overlay_from_home() {
                    let stamp = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|duration| duration.as_secs())
                        .unwrap_or(0);
                    if let Err(quarantine_error) = quarantine_overlay(&overlay, stamp) {
                        eprintln!("failed to quarantine overlay: {quarantine_error}");
                    }
                }
                match start_sidecar(&app, &state, true) {
                    Ok(None) => return,
                    Ok(Some(_)) => match wait_for_health(Duration::from_secs(15)) {
                        Ok(()) => {
                            if lifecycle_is_stopping(&state.0) {
                                return;
                            }
                            open_main_window(&app);
                            return;
                        }
                        Err(retry_error) => {
                            if lifecycle_is_stopping(&state.0) {
                                return;
                            }
                            eprintln!("desktop health check failed: {retry_error}");
                        }
                    },
                    Err(retry_error) => {
                        if lifecycle_is_stopping(&state.0) {
                            return;
                        }
                        eprintln!("desktop bootstrap failed: {retry_error}");
                    }
                }
            } else {
                eprintln!("desktop health check failed: {error}");
            }
            open_startup_error(&app, &state);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar_state = SidecarState::default();
    let bootstrap_state = BootstrapState::default();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(sidecar_state.clone())
        .setup(|app| {
            install_desktop_shell(app.handle())?;
            Ok(())
        })
        .on_window_event({
            let state = sidecar_state.clone();
            move |window, event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if window.label() == "startup-error" {
                        stop_sidecar(&state);
                        window.app_handle().exit(0);
                        return;
                    }
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Balance")
        .run({
            let state = sidecar_state.clone();
            let bootstrap_state = bootstrap_state.clone();
            move |app, event| match event {
                RunEvent::Ready => {
                    if claim_bootstrap(&bootstrap_state) {
                        eprintln!("Balance desktop app is ready; starting bootstrap");
                        let handle = app.clone();
                        let state_for_thread = state.clone();
                        thread::spawn(move || bootstrap(handle, state_for_thread));
                    }
                }
                #[cfg(target_os = "macos")]
                RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    if !has_visible_windows {
                        show_main_window(app);
                    }
                }
                RunEvent::ExitRequested { .. } | RunEvent::Exit => stop_sidecar(&state),
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_origin_is_stable() {
        assert_eq!(sidecar_url(), "http://127.0.0.1:4780");
    }

    #[test]
    fn bootstrap_claim_is_one_shot() {
        let state = BootstrapState::default();
        assert!(claim_bootstrap(&state));
        assert!(!claim_bootstrap(&state));
    }

    #[test]
    fn health_check_accepts_only_balance_desktop() {
        assert!(is_desktop_health_response(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"app\":\"balance\",\"mode\":\"desktop\"}"
        ));
        assert!(!is_desktop_health_response(
            "HTTP/1.1 200 OK\r\n\r\n{\"app\":\"synq\",\"mode\":\"desktop\"}"
        ));
        assert!(!is_desktop_health_response(
            "HTTP/1.1 200 OK\r\n\r\n{\"app\":\"other\",\"mode\":\"desktop\"}"
        ));
        assert!(!is_desktop_health_response(
            "HTTP/1.1 503 Service Unavailable\r\n\r\n{\"app\":\"balance\",\"mode\":\"desktop\"}"
        ));
        assert!(is_desktop_health_response(
            "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n22\r\n{\"app\":\"balance\",\"mode\":\"desktop\"}\r\n0\r\n\r\n"
        ));
    }

    #[test]
    fn stopping_rejects_a_child_installed_after_spawn() {
        use std::sync::Barrier;

        let lifecycle = Arc::new(Mutex::new(LifecycleState::<u8>::default()));
        let spawned = Arc::new(Barrier::new(2));
        let allow_install = Arc::new(Barrier::new(2));
        let worker_lifecycle = lifecycle.clone();
        let worker_spawned = spawned.clone();
        let worker_allow_install = allow_install.clone();
        let worker = thread::spawn(move || {
            worker_spawned.wait();
            worker_allow_install.wait();
            install_spawned_child(&worker_lifecycle, 42)
        });

        spawned.wait();
        assert_eq!(stop_lifecycle(&lifecycle), None);
        allow_install.wait();
        assert_eq!(worker.join().expect("install worker panicked"), Err(42));

        let state = lifecycle.lock().expect("lifecycle mutex poisoned");
        assert!(state.stopping);
        assert!(state.child.is_none());
    }

    #[test]
    fn desktop_sidecar_environment_is_allowlisted() {
        use std::ffi::OsString;

        let filtered = filtered_sidecar_environment([
            (OsString::from("HOME"), OsString::from("/Users/test")),
            (OsString::from("GROK_HOME"), OsString::from("/tmp/grok")),
            (OsString::from("CODEX_HOME"), OsString::from("/tmp/codex")),
            (OsString::from("TMPDIR"), OsString::from("/tmp")),
            (OsString::from("LANG"), OsString::from("en_US.UTF-8")),
            (OsString::from("LC_ALL"), OsString::from("C")),
            (
                OsString::from("DATABASE_URL"),
                OsString::from("postgres://secret"),
            ),
            (
                OsString::from("BETTER_AUTH_SECRET"),
                OsString::from("secret"),
            ),
            (
                OsString::from("GROK_AUTH_CLIENT_SECRET"),
                OsString::from("secret"),
            ),
            (
                OsString::from("NODE_OPTIONS"),
                OsString::from("--require=sentinel"),
            ),
            (
                OsString::from("HTTPS_PROXY"),
                OsString::from("http://proxy"),
            ),
        ]);

        let keys = filtered.into_iter().map(|(key, _)| key).collect::<Vec<_>>();
        assert_eq!(
            keys,
            [
                "HOME",
                "GROK_HOME",
                "CODEX_HOME",
                "TMPDIR",
                "LANG",
                "LC_ALL"
            ]
            .into_iter()
            .map(OsString::from)
            .collect::<Vec<_>>()
        );
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "balance-overlay-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("create unique temp dir");
        dir
    }

    fn write_overlay_fixture(overlay: &std::path::Path, pack_json: &str) {
        std::fs::create_dir_all(overlay.join("server")).expect("server dir");
        std::fs::create_dir_all(overlay.join("public")).expect("public dir");
        std::fs::write(overlay.join("server").join("index.mjs"), "export {}\n").expect("index.mjs");
        std::fs::write(overlay.join("pack.json"), pack_json).expect("pack.json");
    }

    #[test]
    fn json_string_field_reads_pretty_printed_min_native_version() {
        let text = "{\n  \"minNativeVersion\": \"0.1.1\"\n}\n";
        assert_eq!(
            json_string_field(text, "minNativeVersion").as_deref(),
            Some("0.1.1")
        );
    }

    #[test]
    fn overlay_is_usable_when_compatible_with_public_and_index() {
        let overlay = unique_temp_dir("usable").join("current");
        write_overlay_fixture(
            &overlay,
            "{\n  \"packVersion\": \"0.1.1\",\n  \"minNativeVersion\": \"0.1.0\"\n}\n",
        );
        assert!(overlay_is_usable(&overlay, "0.1.0", None));
        assert!(overlay_is_usable(&overlay, "0.1.1", Some("0.1.1")));
    }

    #[test]
    fn overlay_is_unusable_when_index_or_public_is_missing() {
        let missing_index = unique_temp_dir("missing-index").join("current");
        std::fs::create_dir_all(missing_index.join("public")).expect("public dir");
        std::fs::write(
            missing_index.join("pack.json"),
            "{\n  \"packVersion\": \"0.1.1\",\n  \"minNativeVersion\": \"0.1.0\"\n}\n",
        )
        .expect("pack.json");
        assert!(!overlay_is_usable(&missing_index, "0.1.0", None));

        let missing_public = unique_temp_dir("missing-public").join("current");
        std::fs::create_dir_all(missing_public.join("server")).expect("server dir");
        std::fs::write(
            missing_public.join("server").join("index.mjs"),
            "export {}\n",
        )
        .expect("index.mjs");
        std::fs::write(
            missing_public.join("pack.json"),
            "{\n  \"packVersion\": \"0.1.1\",\n  \"minNativeVersion\": \"0.1.0\"\n}\n",
        )
        .expect("pack.json");
        assert!(!overlay_is_usable(&missing_public, "0.1.0", None));
    }

    #[test]
    fn overlay_is_unusable_when_min_native_is_newer() {
        let overlay = unique_temp_dir("min-native").join("current");
        write_overlay_fixture(
            &overlay,
            "{\n  \"packVersion\": \"0.1.2\",\n  \"minNativeVersion\": \"0.1.2\"\n}\n",
        );
        assert!(!overlay_is_usable(&overlay, "0.1.1", None));
    }

    #[test]
    fn overlay_does_not_downgrade_bundled_pack() {
        let overlay = unique_temp_dir("downgrade").join("current");
        write_overlay_fixture(
            &overlay,
            "{\n  \"packVersion\": \"0.1.0\",\n  \"minNativeVersion\": \"0.1.0\"\n}\n",
        );
        assert!(!overlay_is_usable(&overlay, "0.1.1", Some("0.1.1")));
    }

    #[test]
    fn overlay_is_allowed_without_bundled_pack_version() {
        let overlay = unique_temp_dir("no-bundled").join("current");
        write_overlay_fixture(
            &overlay,
            "{\n  \"packVersion\": \"0.1.0\",\n  \"minNativeVersion\": \"0.1.0\"\n}\n",
        );
        assert!(overlay_is_usable(&overlay, "0.1.1", None));
    }

    #[test]
    fn quarantine_renames_current_to_failed_stamp() {
        let home = unique_temp_dir("quarantine");
        let overlay = home.join("current");
        write_overlay_fixture(
            &overlay,
            "{\n  \"packVersion\": \"0.1.1\",\n  \"minNativeVersion\": \"0.1.0\"\n}\n",
        );
        quarantine_overlay(&overlay, 7).expect("quarantine overlay");
        assert!(!overlay.exists());
        assert!(home
            .join("failed-7")
            .join("server")
            .join("index.mjs")
            .is_file());
    }

    #[test]
    fn take_child_for_retry_does_not_set_stopping() {
        let lifecycle = Mutex::new(LifecycleState::<u8>::default());
        assert_eq!(install_spawned_child(&lifecycle, 7), Ok(()));
        assert_eq!(take_child_for_retry(&lifecycle), Some(7));
        {
            let state = lifecycle.lock().expect("lifecycle mutex poisoned");
            assert!(!state.stopping);
            assert!(state.child.is_none());
        }
        assert_eq!(install_spawned_child(&lifecycle, 9), Ok(()));
        let state = lifecycle.lock().expect("lifecycle mutex poisoned");
        assert!(!state.stopping);
        assert_eq!(state.child, Some(9));
    }
}
