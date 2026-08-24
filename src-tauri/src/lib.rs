use std::{
    ffi::{OsStr, OsString},
    fs::OpenOptions,
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
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, RunEvent, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
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
const TRAY_WINDOW: &str = "tray";
const TRAY_SHOW_MAIN_PATH: &str = "/__desktop/show-main";
const TRAY_WIDTH: f64 = 360.0;
const TRAY_HEIGHT: f64 = 468.0;
const TRAY_CLICK_DEBOUNCE: Duration = Duration::from_millis(280);
const SIDECAR_GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(17);

#[derive(Debug)]
struct OrchestratorStateDirectory {
    path: PathBuf,
    e2e_override: bool,
}

#[derive(Debug)]
struct StartedSidecar {
    used_overlay: bool,
    capability: String,
}

fn default_orchestrator_state_path(data_dir: &Path) -> PathBuf {
    data_dir.join("Balance").join("orchestrator")
}

#[cfg(unix)]
fn ensure_owned_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "private state path is not a real directory: {}",
            path.display()
        ));
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(format!(
            "private state path has the wrong owner: {}",
            path.display()
        ));
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("failed to secure {}: {error}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn ensure_owned_directory(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "private state path is not a real directory: {}",
            path.display()
        ));
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<PathBuf, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path)
                .map_err(|error| format!("failed to create {}: {error}", path.display()))?;
        }
        Err(error) => {
            return Err(format!("failed to inspect {}: {error}", path.display()));
        }
    }
    ensure_owned_directory(path)?;
    path.canonicalize()
        .map_err(|error| format!("failed to canonicalize {}: {error}", path.display()))
}

#[cfg(any(debug_assertions, test))]
fn ensure_debug_e2e_state_dir(path: &Path, temp_root: &Path) -> Result<PathBuf, String> {
    use std::path::Component;

    if !path.is_absolute() {
        return Err("BALANCE_E2E_STATE_DIR must be absolute".into());
    }
    let canonical_temp = temp_root
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize system temp: {error}"))?;
    let (base, relative) = if let Ok(relative) = path.strip_prefix(temp_root) {
        (temp_root.to_path_buf(), relative)
    } else if let Ok(relative) = path.strip_prefix(&canonical_temp) {
        (canonical_temp.clone(), relative)
    } else {
        return Err("BALANCE_E2E_STATE_DIR must be below the system temp directory".into());
    };
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("BALANCE_E2E_STATE_DIR must be a strict temp descendant".into());
    }

    let mut current = base;
    for component in relative.components() {
        current.push(component.as_os_str());
        ensure_private_directory(&current)?;
    }
    let canonical = current
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize E2E state directory: {error}"))?;
    if canonical == canonical_temp || !canonical.starts_with(&canonical_temp) {
        return Err("BALANCE_E2E_STATE_DIR escaped the system temp directory".into());
    }
    Ok(canonical)
}

fn orchestrator_state_dir(app: &AppHandle) -> Result<OrchestratorStateDirectory, String> {
    #[cfg(debug_assertions)]
    if let Some(override_path) = std::env::var_os("BALANCE_E2E_STATE_DIR") {
        let path =
            ensure_debug_e2e_state_dir(&PathBuf::from(override_path), &std::env::temp_dir())?;
        return Ok(OrchestratorStateDirectory {
            path,
            e2e_override: true,
        });
    }

    let data_dir = app.path().data_dir().map_err(|error| error.to_string())?;
    let requested = default_orchestrator_state_path(&data_dir);
    let balance_dir = ensure_private_directory(
        requested
            .parent()
            .ok_or_else(|| "orchestrator state directory has no parent".to_string())?,
    )?;
    let path = ensure_private_directory(&balance_dir.join("orchestrator"))?;
    Ok(OrchestratorStateDirectory {
        path,
        e2e_override: false,
    })
}

fn random_capability() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut bytes))
        .map_err(|error| format!("failed to generate orchestrator capability: {error}"))?;
    let mut capability = String::with_capacity(64);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut capability, "{byte:02x}")
            .map_err(|error| format!("failed to encode orchestrator capability: {error}"))?;
    }
    Ok(capability)
}

fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    #[cfg(unix)]
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("failed to secure {}: {error}", path.display()))?;
    file.write_all(contents)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

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

#[derive(Clone, Default)]
struct TrayPopupState(Arc<Mutex<TrayPopupInner>>);

#[derive(Default)]
struct TrayPopupInner {
    last_hide: Option<Instant>,
    last_show: Option<Instant>,
}

fn sidecar_url() -> String {
    format!("http://{SIDECAR_HOST}:{SIDECAR_PORT}")
}

fn claim_bootstrap(state: &BootstrapState) -> bool {
    !state.0.swap(true, Ordering::SeqCst)
}

fn force_stop_sidecar(state: &SidecarState) {
    if let Some(child) = stop_lifecycle(&state.0) {
        let _ = child.kill();
    }
}

fn graceful_stop_sidecar(state: &SidecarState) {
    let should_wait = {
        let mut lifecycle = state.0.lock().expect("lifecycle mutex poisoned");
        if lifecycle.stopping {
            false
        } else {
            lifecycle.stopping = true;
            if let Some(child) = lifecycle.child.as_mut() {
                if let Err(error) = child.write(b"BALANCE_SHUTDOWN\n") {
                    eprintln!("failed to signal orchestrator shutdown: {error}");
                }
            }
            lifecycle.child.is_some()
        }
    };
    if !should_wait {
        return;
    }

    let deadline = Instant::now() + SIDECAR_GRACEFUL_STOP_TIMEOUT;
    loop {
        if state
            .0
            .lock()
            .expect("lifecycle mutex poisoned")
            .child
            .is_none()
        {
            return;
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }

    let child = state
        .0
        .lock()
        .expect("lifecycle mutex poisoned")
        .child
        .take();
    if let Some(child) = child {
        eprintln!("orchestrator did not stop within 17 seconds; killing sidecar");
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

fn remember_tray_hide(state: &TrayPopupState) {
    state.0.lock().expect("tray popup mutex poisoned").last_hide = Some(Instant::now());
}

fn remember_tray_show(state: &TrayPopupState) {
    state.0.lock().expect("tray popup mutex poisoned").last_show = Some(Instant::now());
}

fn should_ignore_tray_show(last_hide: Option<Instant>, now: Instant) -> bool {
    last_hide
        .map(|hidden_at| now.saturating_duration_since(hidden_at) < TRAY_CLICK_DEBOUNCE)
        .unwrap_or(false)
}

fn should_ignore_tray_blur(last_show: Option<Instant>, now: Instant) -> bool {
    last_show
        .map(|shown_at| now.saturating_duration_since(shown_at) < TRAY_CLICK_DEBOUNCE)
        .unwrap_or(false)
}

fn tray_show_is_echo(state: &TrayPopupState) -> bool {
    let last_hide = state.0.lock().expect("tray popup mutex poisoned").last_hide;
    should_ignore_tray_show(last_hide, Instant::now())
}

fn tray_blur_is_echo(state: &TrayPopupState) -> bool {
    let last_show = state.0.lock().expect("tray popup mutex poisoned").last_show;
    should_ignore_tray_blur(last_show, Instant::now())
}

fn tray_popup_origin(
    icon_x: f64,
    icon_y: f64,
    icon_w: f64,
    icon_h: f64,
    win_w: f64,
    win_h: f64,
    mon_x: f64,
    mon_y: f64,
    mon_w: f64,
    mon_h: f64,
) -> (f64, f64) {
    let mut x = icon_x + icon_w / 2.0 - win_w / 2.0;
    let mut y = icon_y + icon_h + 6.0;
    let min_x = mon_x + 8.0;
    let max_x = (mon_x + mon_w - win_w - 8.0).max(min_x);
    x = x.clamp(min_x, max_x);
    let min_y = mon_y + 8.0;
    let max_y = (mon_y + mon_h - win_h - 8.0).max(min_y);
    if y + win_h > mon_y + mon_h - 8.0 {
        y = icon_y - win_h - 6.0;
    }
    y = y.clamp(min_y, max_y);
    (x, y)
}

fn is_show_main_path(path: &str) -> bool {
    path == TRAY_SHOW_MAIN_PATH
}

fn current_scale(app: &AppHandle) -> f64 {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0)
}

fn hide_tray_dashboard(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(TRAY_WINDOW) {
        let _ = window.hide();
    }
    if let Some(state) = app.try_state::<TrayPopupState>() {
        remember_tray_hide(&state);
    }
}

fn show_main_window(app: &AppHandle) {
    hide_tray_dashboard(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn position_tray_dashboard(
    app: &AppHandle,
    window: &WebviewWindow,
    icon_x: f64,
    icon_y: f64,
    icon_w: f64,
    icon_h: f64,
) {
    let scale = window.scale_factor().unwrap_or_else(|_| current_scale(app));
    let win_size = window
        .outer_size()
        .ok()
        .map(|size| size.to_logical::<f64>(scale))
        .unwrap_or(LogicalSize::new(TRAY_WIDTH, TRAY_HEIGHT));
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let (mon_x, mon_y, mon_w, mon_h) = if let Some(monitor) = monitor {
        let factor = monitor.scale_factor();
        let pos = monitor.position().to_logical::<f64>(factor);
        let size = monitor.size().to_logical::<f64>(factor);
        (pos.x, pos.y, size.width, size.height)
    } else {
        (0.0, 0.0, 1440.0, 900.0)
    };
    let (x, y) = tray_popup_origin(
        icon_x,
        icon_y,
        icon_w,
        icon_h,
        win_size.width,
        win_size.height,
        mon_x,
        mon_y,
        mon_w,
        mon_h,
    );
    let _ = window.set_position(LogicalPosition::new(x, y));
}

fn ensure_tray_dashboard(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(window) = app.get_webview_window(TRAY_WINDOW) {
        return Some(window);
    }
    if !request_health().unwrap_or(false) {
        return None;
    }
    let url = format!("{}/tray", sidecar_url()).parse().ok()?;
    let handle = app.clone();
    WebviewWindowBuilder::new(app, TRAY_WINDOW, WebviewUrl::External(url))
        .title("余量周限额")
        .inner_size(TRAY_WIDTH, TRAY_HEIGHT)
        .min_inner_size(TRAY_WIDTH, TRAY_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .shadow(true)
        .on_navigation(move |url| {
            if is_show_main_path(url.path()) {
                show_main_window(&handle);
                return false;
            }
            true
        })
        .build()
        .ok()
}

fn toggle_tray_dashboard(app: &AppHandle, icon_x: f64, icon_y: f64, icon_w: f64, icon_h: f64) {
    if let Some(window) = app.get_webview_window(TRAY_WINDOW) {
        if window.is_visible().unwrap_or(false) {
            hide_tray_dashboard(app);
            return;
        }
    }
    if let Some(state) = app.try_state::<TrayPopupState>() {
        if tray_show_is_echo(&state) {
            return;
        }
    }
    let Some(window) = ensure_tray_dashboard(app) else {
        return;
    };
    if let Some(state) = app.try_state::<TrayPopupState>() {
        remember_tray_show(&state);
    }
    position_tray_dashboard(app, &window, icon_x, icon_y, icon_w, icon_h);
    let _ = window.show();
    let _ = window.set_focus();
}

fn quit_app(app: &AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        app.exit(0);
        return;
    };
    let state = state.inner().clone();
    let handle = app.clone();
    thread::spawn(move || {
        graceful_stop_sidecar(&state);
        handle.exit(0);
    });
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
                    rect,
                    ..
                } = event
                {
                    let app = tray.app_handle();
                    let scale = current_scale(app);
                    let pos = rect.position.to_logical::<f64>(scale);
                    let size = rect.size.to_logical::<f64>(scale);
                    toggle_tray_dashboard(app, pos.x, pos.y, size.width, size.height);
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
) -> Result<(PathBuf, PathBuf, PathBuf, bool, PathBuf), String> {
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
    let collector = resource_dir.join("claude-statusline.mjs");
    if !collector.is_file() {
        return Err(format!(
            "Claude statusline collector is missing: {}",
            collector.display()
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
    Ok((root, entry, watchdog, used_overlay, collector))
}

fn install_statusline_collector(app: &AppHandle, source: &Path) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let directory = home
        .join(".local")
        .join("share")
        .join("balance")
        .join("bin");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::Permissions::from_mode(0o700);
        std::fs::set_permissions(&directory, permissions).map_err(|error| error.to_string())?;
    }
    let target = directory.join("claude-statusline.mjs");
    std::fs::copy(source, &target).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::Permissions::from_mode(0o700);
        std::fs::set_permissions(&target, permissions).map_err(|error| error.to_string())?;
    }
    Ok(target)
}

fn statusline_snapshot_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let root = match std::env::consts::OS {
        "macos" => home
            .join("Library")
            .join("Application Support")
            .join("Balance"),
        "windows" => std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"))
            .join("Balance"),
        _ => std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local").join("state"))
            .join("balance"),
    };
    Ok(root.join("claude-statusline.json"))
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

fn should_force_bundled_layout(force_bundled: bool, e2e_override: bool) -> bool {
    force_bundled || e2e_override
}

fn start_sidecar(
    app: &AppHandle,
    state: &SidecarState,
    force_bundled: bool,
) -> Result<Option<StartedSidecar>, String> {
    ensure_port_available()?;
    let state_directory = orchestrator_state_dir(app)?;
    let capability = random_capability()?;
    if state_directory.e2e_override {
        write_private_file(
            &state_directory.path.join("e2e-token"),
            capability.as_bytes(),
        )?;
    }
    let (server_root, server_entry, watchdog, used_overlay, collector) = resolve_server_layout(
        app,
        should_force_bundled_layout(force_bundled, state_directory.e2e_override),
    )?;
    let installed_collector = install_statusline_collector(app, &collector)?;
    let statusline_snapshot = statusline_snapshot_path(app)?;
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
        .env(
            "BALANCE_STATE_DIR",
            state_directory.path.to_string_lossy().to_string(),
        )
        .env("BALANCE_ORCHESTRATOR_TOKEN", capability.clone())
        .env("VITE_AUTH_ENABLED", "false")
        .env("NODE_ENV", "production")
        .env(
            "BALANCE_CLAUDE_STATUSLINE_COLLECTOR",
            installed_collector.to_string_lossy().to_string(),
        )
        .env(
            "BALANCE_CLAUDE_STATUSLINE_PATH",
            statusline_snapshot.to_string_lossy().to_string(),
        )
        .spawn()
        .map_err(|error| error.to_string())?;
    if let Err(child) = install_spawned_child(&state.0, child) {
        child
            .kill()
            .map_err(|error| format!("failed to stop sidecar during shutdown: {error}"))?;
        return Ok(None);
    }
    drain_sidecar_events(receiver, state.clone());
    Ok(Some(StartedSidecar {
        used_overlay,
        capability,
    }))
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

fn open_main_window(app: &AppHandle, capability: &str) {
    let url = format!("{}#balance-token={capability}", sidecar_url())
        .parse()
        .expect("the fixed Balance loopback URL must parse");
    open_window(app, "main", WebviewUrl::External(url));
}

fn open_startup_error(app: &AppHandle, state: &SidecarState) {
    force_stop_sidecar(state);
    open_window(
        app,
        "startup-error",
        WebviewUrl::App("startup-error.html".into()),
    );
}

fn bootstrap(app: AppHandle, state: SidecarState) {
    let started = match start_sidecar(&app, &state, false) {
        Ok(Some(started)) => started,
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
            open_main_window(&app, &started.capability);
        }
        Err(error) => {
            if lifecycle_is_stopping(&state.0) {
                return;
            }
            if started.used_overlay {
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
                    Ok(Some(retry)) => match wait_for_health(Duration::from_secs(15)) {
                        Ok(()) => {
                            if lifecycle_is_stopping(&state.0) {
                                return;
                            }
                            open_main_window(&app, &retry.capability);
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .manage(sidecar_state.clone())
        .manage(TrayPopupState::default())
        .setup(|app| {
            install_desktop_shell(app.handle())?;
            Ok(())
        })
        .on_window_event({
            let state = sidecar_state.clone();
            move |window, event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "startup-error" {
                        force_stop_sidecar(&state);
                        window.app_handle().exit(0);
                        return;
                    }
                    api.prevent_close();
                    let _ = window.hide();
                    if window.label() == TRAY_WINDOW {
                        hide_tray_dashboard(window.app_handle());
                    }
                }
                WindowEvent::Focused(false) if window.label() == TRAY_WINDOW => {
                    if !window.is_visible().unwrap_or(false) {
                        return;
                    }
                    if let Some(state) = window.app_handle().try_state::<TrayPopupState>() {
                        if tray_blur_is_echo(&state) {
                            return;
                        }
                    }
                    hide_tray_dashboard(window.app_handle());
                }
                _ => {}
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
                RunEvent::Reopen { .. } => show_main_window(app),
                RunEvent::ExitRequested { .. } | RunEvent::Exit => graceful_stop_sidecar(&state),
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
    fn orchestrator_state_path_is_scoped_below_balance_data() {
        assert_eq!(
            default_orchestrator_state_path(Path::new("/data")),
            Path::new("/data").join("Balance").join("orchestrator")
        );
    }

    #[test]
    fn debug_e2e_state_forces_the_current_bundled_web_app() {
        assert!(should_force_bundled_layout(false, true));
        assert!(should_force_bundled_layout(true, false));
        assert!(!should_force_bundled_layout(false, false));
    }

    #[test]
    fn random_capability_is_256_bit_lowercase_hex() {
        let capability = random_capability().expect("random capability");
        assert_eq!(capability.len(), 64);
        assert!(capability
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }

    #[cfg(unix)]
    #[test]
    fn private_directory_is_0700_and_rejects_symlink() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let parent = unique_temp_dir("private-state");
        let balance = parent.join("Balance");
        ensure_private_directory(&balance).expect("private Balance directory");
        let private = balance.join("orchestrator");
        ensure_private_directory(&private).expect("private state directory");
        assert_eq!(
            std::fs::metadata(&private)
                .expect("private state metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );

        let target = parent.join("target");
        std::fs::create_dir(&target).expect("symlink target");
        let link = parent.join("linked-state");
        symlink(&target, &link).expect("state symlink");
        assert!(ensure_private_directory(&link).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn e2e_state_directory_must_be_a_temp_descendant_without_symlinks() {
        use std::os::unix::fs::symlink;

        let test_temp = unique_temp_dir("e2e-root");
        let valid = test_temp.join("valid");
        let canonical = ensure_debug_e2e_state_dir(&valid, &test_temp).expect("valid e2e dir");
        assert_eq!(
            canonical,
            valid.canonicalize().expect("canonical valid dir")
        );
        assert!(ensure_debug_e2e_state_dir(Path::new("/"), &test_temp).is_err());

        let target = test_temp.join("target");
        std::fs::create_dir(&target).expect("symlink target");
        let link = test_temp.join("link");
        symlink(&target, &link).expect("e2e symlink");
        assert!(ensure_debug_e2e_state_dir(&link, &test_temp).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn e2e_capability_file_is_private() {
        use std::os::unix::fs::PermissionsExt;

        let directory = unique_temp_dir("e2e-token");
        let token_path = directory.join("e2e-token");
        write_private_file(&token_path, b"secret").expect("private token file");
        assert_eq!(
            std::fs::read_to_string(&token_path).expect("token"),
            "secret"
        );
        assert_eq!(
            std::fs::metadata(&token_path)
                .expect("token metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
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

    #[test]
    fn tray_popup_stays_on_the_monitor() {
        let (x, y) = tray_popup_origin(
            1400.0, 4.0, 22.0, 22.0, 360.0, 468.0, 0.0, 0.0, 1440.0, 900.0,
        );
        assert!(x >= 8.0);
        assert!(x + 360.0 <= 1432.0);
        assert_eq!(y, 32.0);
        assert_eq!(is_show_main_path("/__desktop/show-main"), true);
        assert_eq!(is_show_main_path("/tray"), false);
    }

    #[test]
    fn tray_click_echo_is_debounced() {
        let hidden_at = Instant::now();
        assert!(should_ignore_tray_show(
            Some(hidden_at),
            hidden_at + Duration::from_millis(100)
        ));
        assert!(!should_ignore_tray_show(
            Some(hidden_at),
            hidden_at + Duration::from_millis(400)
        ));
        assert!(!should_ignore_tray_show(None, Instant::now()));
        assert!(should_ignore_tray_blur(
            Some(hidden_at),
            hidden_at + Duration::from_millis(50)
        ));
        assert!(!should_ignore_tray_blur(
            Some(hidden_at),
            hidden_at + Duration::from_millis(400)
        ));
    }
}
