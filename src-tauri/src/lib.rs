use std::{
    ffi::{OsStr, OsString},
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const SIDECAR_BIN: &str = "synq-node";
const SIDECAR_HOST: &str = "127.0.0.1";
const SIDECAR_PORT: u16 = 4780;
const HEALTH_BODY: &str = "{\"app\":\"synq\",\"mode\":\"desktop\"}";
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

fn clear_sidecar(state: &SidecarState) {
    clear_lifecycle_child(&state.0);
}

fn ensure_port_available() -> Result<(), String> {
    TcpListener::bind((SIDECAR_HOST, SIDECAR_PORT))
        .map(|listener| drop(listener))
        .map_err(|error| format!("{SIDECAR_HOST}:{SIDECAR_PORT} is unavailable: {error}"))
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

fn is_synq_health_response(response: &str) -> bool {
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
    Ok(is_synq_health_response(&response))
}

fn wait_for_health(timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if request_health().unwrap_or(false) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err("timed out waiting for the Synq desktop server".to_owned())
}

fn server_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let root = resource_dir.join("synq-server");
    let entry = root.join("server").join("index.mjs");
    if !entry.is_file() {
        return Err(format!(
            "desktop server entry is missing: {}",
            entry.display()
        ));
    }
    let watchdog = resource_dir.join("sidecar-watchdog.cjs");
    if !watchdog.is_file() {
        return Err(format!(
            "desktop sidecar watchdog is missing: {}",
            watchdog.display()
        ));
    }
    Ok((root, entry, watchdog))
}

fn drain_sidecar_events(
    mut receiver: tauri::async_runtime::Receiver<CommandEvent>,
    state: SidecarState,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    eprintln!("[synq-node][stdout] {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("[synq-node][stderr] {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Error(error) => {
                    eprintln!("[synq-node][error] {error}");
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!(
                        "[synq-node] terminated: code={:?}, signal={:?}",
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

fn start_sidecar(app: &AppHandle, state: &SidecarState) -> Result<bool, String> {
    ensure_port_available()?;
    let (server_root, server_entry, watchdog) = server_paths(app)?;
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
        .env("SYNQ_DESKTOP", "1")
        .env("SYNQ_PARENT_PID", std::process::id().to_string())
        .env("VITE_AUTH_ENABLED", "false")
        .env("NODE_ENV", "production")
        .spawn()
        .map_err(|error| error.to_string())?;
    if let Err(child) = install_spawned_child(&state.0, child) {
        child
            .kill()
            .map_err(|error| format!("failed to stop sidecar during shutdown: {error}"))?;
        return Ok(false);
    }
    drain_sidecar_events(receiver, state.clone());
    Ok(true)
}

fn open_window(app: &AppHandle, label: &'static str, url: WebviewUrl) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Err(error) = WebviewWindowBuilder::new(&handle, label, url)
            .title("Synq")
            .inner_size(1440.0, 960.0)
            .min_inner_size(960.0, 680.0)
            .center()
            .resizable(true)
            .build()
        {
            eprintln!("failed to create Synq window: {error}");
            handle.exit(1);
        }
    }) {
        eprintln!("failed to schedule Synq window creation: {error}");
        app.exit(1);
    }
}

fn bootstrap(app: AppHandle, state: SidecarState) {
    match start_sidecar(&app, &state) {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => {
            if lifecycle_is_stopping(&state.0) {
                return;
            }
            eprintln!("desktop bootstrap failed: {error}");
            stop_sidecar(&state);
            open_window(
                &app,
                "startup-error",
                WebviewUrl::App("startup-error.html".into()),
            );
            return;
        }
    }
    match wait_for_health(Duration::from_secs(15)) {
        Ok(()) => {
            if lifecycle_is_stopping(&state.0) {
                return;
            }
            let url = sidecar_url()
                .parse()
                .expect("the fixed Synq loopback URL must parse");
            open_window(&app, "main", WebviewUrl::External(url));
        }
        Err(error) => {
            if lifecycle_is_stopping(&state.0) {
                return;
            }
            eprintln!("desktop health check failed: {error}");
            stop_sidecar(&state);
            open_window(
                &app,
                "startup-error",
                WebviewUrl::App("startup-error.html".into()),
            );
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
        .on_window_event({
            let state = sidecar_state.clone();
            move |window, event| {
                if let WindowEvent::CloseRequested { .. } = event {
                    stop_sidecar(&state);
                    window.app_handle().exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Synq")
        .run({
            let state = sidecar_state.clone();
            let bootstrap_state = bootstrap_state.clone();
            move |app, event| match event {
                RunEvent::Ready => {
                    if claim_bootstrap(&bootstrap_state) {
                        eprintln!("Synq desktop app is ready; starting bootstrap");
                        let handle = app.clone();
                        let state_for_thread = state.clone();
                        thread::spawn(move || bootstrap(handle, state_for_thread));
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
    fn health_check_accepts_only_synq_desktop() {
        assert!(is_synq_health_response(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"app\":\"synq\",\"mode\":\"desktop\"}"
        ));
        assert!(!is_synq_health_response(
            "HTTP/1.1 200 OK\r\n\r\n{\"app\":\"other\",\"mode\":\"desktop\"}"
        ));
        assert!(!is_synq_health_response(
            "HTTP/1.1 503 Service Unavailable\r\n\r\n{\"app\":\"synq\",\"mode\":\"desktop\"}"
        ));
        assert!(is_synq_health_response(
            "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n1f\r\n{\"app\":\"synq\",\"mode\":\"desktop\"}\r\n0\r\n\r\n"
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
}
