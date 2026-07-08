use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Preferred backend port; the sidecar may announce a different free port.
const BACKEND_PORT: u16 = 8000;

/// Live backend port, seeded with the preferred port until readiness is announced.
struct AnnouncedPort(Mutex<u16>);

/// Live backend child process, shared by restart and shutdown paths.
struct BackendChild(Mutex<Option<CommandChild>>);

/// Suppresses stale crash events from a backend process replaced by restart.
struct BackendGeneration(AtomicU64);

/// Take-once first-launch file association path.
struct PendingOpenFile(Mutex<Option<String>>);

/// Payload for the `backend-ready` Tauri event.
#[derive(Clone, Serialize)]
struct BackendReadyPayload {
    port: u16,
}

/// Payload for startup failure before the backend is ready.
#[derive(Clone, Serialize)]
struct BackendFailedPayload {
    reason: String,
}

/// Payload for backend exits after readiness.
#[derive(Clone, Serialize)]
struct BackendCrashedPayload {
    code: Option<i32>,
}

/// Payload for the `open-file` Tauri event (second-instance file association).
#[derive(Clone, Serialize)]
struct OpenFilePayload {
    path: String,
}

/// First argv entry that looks like an IFC file path.
fn ifc_path_from_argv<S: AsRef<str>>(args: &[S]) -> Option<String> {
    args.iter().map(|a| a.as_ref()).find_map(|a| {
        if a.starts_with('-') {
            return None;
        }
        if !a.to_ascii_lowercase().ends_with(".ifc") {
            return None;
        }
        Some(a.to_string())
    })
}

/// Tauri command: backend base URL for the webview.
#[tauri::command]
fn get_backend_url(state: tauri::State<'_, AnnouncedPort>) -> String {
    let port = *state.0.lock().unwrap_or_else(|e| e.into_inner());
    format!("http://127.0.0.1:{}", port)
}

/// Tauri command: take the first-launch file association path once.
#[tauri::command]
fn get_open_with_path(state: tauri::State<'_, PendingOpenFile>) -> Option<String> {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).take()
}

/// Tauri command: read an `.ifc` file for the file-association flow.
#[tauri::command]
fn read_ifc_file(path: String) -> Result<tauri::ipc::Response, String> {
    if !path.to_ascii_lowercase().ends_with(".ifc") {
        return Err("Only .ifc files can be opened this way".into());
    }
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("Could not read {path}: {e}"))
}

/// Tauri command: restart the managed backend sidecar.
#[tauri::command]
fn restart_backend(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(gen) = app.try_state::<BackendGeneration>() {
        gen.0.fetch_add(1, Ordering::SeqCst);
    }
    kill_backend_child(&app);
    spawn_backend(&app)
}

/// Tauri command: reveal the local log directory in the OS file manager.
#[tauri::command]
fn open_logs_dir() -> Result<(), String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "No home directory found".to_string())?;
    let dir = std::path::Path::new(&home).join(".ifc-atlas").join("logs");
    // Create it so the button works even before the first log write.
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(windows)]
    let opener = "explorer";
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let opener = "xdg-open";
    std::process::Command::new(opener)
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open {}: {e}", dir.display()))
}

/// Marker-file path for Linux safe graphics mode.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn safe_graphics_marker_from_home(home: &str) -> std::path::PathBuf {
    std::path::Path::new(home)
        .join(".ifc-atlas")
        .join("safe-graphics")
}

/// Resolve the safe-graphics marker path from the current user's home.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn safe_graphics_marker_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(safe_graphics_marker_from_home(&home))
}

/// Tauri command: whether Linux safe graphics mode is enabled.
#[tauri::command]
fn get_safe_graphics() -> Option<bool> {
    #[cfg(target_os = "linux")]
    {
        Some(safe_graphics_marker_path().map(|p| p.exists()).unwrap_or(false))
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Tauri command: toggle safe graphics mode and restart the app.
#[tauri::command]
fn set_safe_graphics(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let path = safe_graphics_marker_path()
            .ok_or_else(|| "No home directory found".to_string())?;
        if enabled {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
            }
            std::fs::write(
                &path,
                "Marker file: IFC Atlas starts with WebKitGTK GPU workarounds.\n\
                 Delete this file (or use Help > Safe graphics mode) to disable.\n",
            )
            .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
        } else if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Could not remove {}: {e}", path.display()))?;
        }
        app.restart();
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, enabled);
        Err("Safe graphics mode is only available on Linux".into())
    }
}

/// Result of a `check_for_updates` call.
#[derive(Clone, Serialize)]
struct UpdateCheckResult {
    available: bool,
    version: Option<String>,
    notes: Option<String>,
}

/// Tauri command: check the configured updater endpoint for a newer build.
#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateCheckResult, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app
        .updater()
        .map_err(|e| format!("Updater not available in this build: {e}"))?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateCheckResult {
            available: true,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
        }),
        Ok(None) => Ok(UpdateCheckResult {
            available: false,
            version: None,
            notes: None,
        }),
        Err(e) => Err(format!("Update check failed: {e}")),
    }
}

/// Tauri command: download and install the pending update, then restart.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app
        .updater()
        .map_err(|e| format!("Updater not available in this build: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?
        .ok_or_else(|| "No update available".to_string())?;
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| format!("Update install failed: {e}"))?;
    app.restart();
}

/// Kill the stored backend child process tree.
fn kill_backend_child(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<BackendChild>() {
        if let Some(child) = state.0.lock().ok().and_then(|mut g| g.take()) {
            kill_process_tree(child);
        }
    }
}

/// Kill a sidecar child and descendants.
fn kill_process_tree(child: CommandChild) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &child.pid().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &child.pid().to_string()])
            .status();
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    let _ = child.kill();
}

/// Spawn the FastAPI backend sidecar and watch for readiness.
fn spawn_backend(app: &tauri::AppHandle) -> Result<(), String> {
    let shell = app.shell();
    let (mut rx, child) = shell
        .sidecar("ifc-backend")
        .map_err(|e| format!("{e}"))?
        .args(["--host", "127.0.0.1", "--port", &BACKEND_PORT.to_string()])
        .spawn()
        .map_err(|e| format!("{e}"))?;

    if let Some(state) = app.try_state::<BackendChild>() {
        *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
    }
    let my_gen = app
        .try_state::<BackendGeneration>()
        .map(|s| s.0.load(Ordering::SeqCst))
        .unwrap_or(0);
    println!(
        "[tauri] ifc-backend sidecar started (preferred port {}, gen {})",
        BACKEND_PORT, my_gen
    );

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ready_seen = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let trimmed = line.trim_end();
                    print!("[ifc-backend] {trimmed}\n");
                    if let Some(port_str) = trimmed.trim().strip_prefix("BACKEND_READY port=") {
                        if let Ok(port) = port_str.trim().parse::<u16>() {
                            if let Some(state) = handle.try_state::<AnnouncedPort>() {
                                *state.0.lock().unwrap_or_else(|e| e.into_inner()) = port;
                            }
                            ready_seen = true;
                            let _ = handle.emit("backend-ready", BackendReadyPayload { port });
                            println!("[tauri] backend-ready emitted port={port}");
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    eprint!("[ifc-backend:err] {}", line);
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!(
                        "[tauri] ifc-backend sidecar exited: code={:?} signal={:?}",
                        payload.code, payload.signal
                    );
                    let still_current = handle
                        .try_state::<BackendGeneration>()
                        .map(|s| s.0.load(Ordering::SeqCst) == my_gen)
                        .unwrap_or(true);
                    if still_current {
                        if let Some(state) = handle.try_state::<BackendChild>() {
                            if let Ok(mut guard) = state.0.lock() {
                                guard.take();
                            }
                        }
                        if !ready_seen {
                            let _ = handle.emit(
                                "backend-failed",
                                BackendFailedPayload {
                                    reason: format!(
                                        "Backend exited before it was ready (code={:?}).",
                                        payload.code
                                    ),
                                },
                            );
                        } else {
                            let _ = handle.emit(
                                "backend-crashed",
                                BackendCrashedPayload { code: payload.code },
                            );
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

pub fn run() {
    // Linux safe graphics mode must set WebKitGTK flags before the webview is created.
    #[cfg(target_os = "linux")]
    if safe_graphics_marker_path().is_some_and(|p| p.exists()) {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        eprintln!(
            "[tauri] safe graphics mode ON (~/.ifc-atlas/safe-graphics exists): \
             WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1"
        );
    }
    tauri::Builder::default()
        // Single-instance must be first; it forwards later file-open launches.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            if let Some(path) = ifc_path_from_argv(&argv) {
                println!("[tauri] second-instance open-file: {path}");
                let _ = app.emit("open-file", OpenFilePayload { path });
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            get_backend_url,
            get_open_with_path,
            read_ifc_file,
            restart_backend,
            open_logs_dir,
            get_safe_graphics,
            set_safe_graphics,
            check_for_updates,
            install_update
        ])
        .setup(|app| {
            app.manage(AnnouncedPort(Mutex::new(BACKEND_PORT)));
            app.manage(BackendChild(Mutex::new(None)));
            app.manage(BackendGeneration(AtomicU64::new(0)));
            let argv: Vec<String> = std::env::args().skip(1).collect();
            let pending = ifc_path_from_argv(&argv);
            if let Some(ref p) = pending {
                println!("[tauri] launched with open-with file: {p}");
            }
            app.manage(PendingOpenFile(Mutex::new(pending)));

            if let Err(e) = spawn_backend(&app.handle().clone()) {
                eprintln!(
                    "[tauri] failed to start ifc-backend sidecar: {e}\n  \
                     - To build it: scripts/build_sidecar.ps1 (Windows) or \
                     scripts/build_sidecar.sh (Linux/macOS)\n  \
                     - If restarting after a crash, check for a lingering \
                     ifc-backend process holding port {} (Task Manager on \
                     Windows, `pkill -f ifc-backend` elsewhere).",
                    BACKEND_PORT
                );
                let _ = app.handle().emit(
                    "backend-failed",
                    BackendFailedPayload {
                        reason: format!("Failed to start backend sidecar: {e}"),
                    },
                );
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                kill_backend_child(app_handle);
                println!("[tauri] ifc-backend sidecar terminated on app exit");
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{ifc_path_from_argv, safe_graphics_marker_from_home};

    #[test]
    fn picks_first_ifc_path() {
        let args = vec![
            "C:\\Program Files\\IFC Atlas\\ifc-atlas.exe".to_string(),
            "C:\\models\\Office Tower.ifc".to_string(),
        ];
        assert_eq!(
            ifc_path_from_argv(&args),
            Some("C:\\models\\Office Tower.ifc".to_string())
        );
    }

    #[test]
    fn ignores_flags_and_non_ifc() {
        let args = vec![
            "--flag".to_string(),
            "notes.txt".to_string(),
            "MODEL.IFC".to_string(),
        ];
        assert_eq!(ifc_path_from_argv(&args), Some("MODEL.IFC".to_string()));
    }

    #[test]
    fn none_when_no_file() {
        let args: Vec<String> = vec!["--minimized".to_string()];
        assert_eq!(ifc_path_from_argv(&args), None);
    }

    #[test]
    fn safe_graphics_marker_lives_in_dotfolder() {
        let p = safe_graphics_marker_from_home("/home/alice");
        assert!(p.starts_with("/home/alice"));
        assert!(p.ends_with(std::path::Path::new(".ifc-atlas").join("safe-graphics")));
    }

    #[test]
    fn safe_graphics_marker_from_windows_home() {
        let p = safe_graphics_marker_from_home("C:\\Users\\alice");
        assert_eq!(
            p,
            std::path::PathBuf::from("C:\\Users\\alice")
                .join(".ifc-atlas")
                .join("safe-graphics")
        );
    }
}
