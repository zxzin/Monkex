use std::fs::File;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::utils::config::Color;
use tauri::{LogicalPosition, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

const BACKEND_HOST: &str = "127.0.0.1";
const BACKEND_PORT: u16 = 8766;
const COLLAPSED_WIDTH: f64 = 76.0;
const COLLAPSED_HEIGHT: f64 = 76.0;
const COMPACT_WIDTH: f64 = 344.0;
const COMPACT_HEIGHT: f64 = 420.0;
const WINDOW_MARGIN: f64 = 18.0;

static CONTEXT_MENU: OnceLock<Mutex<Option<Menu<tauri::Wry>>>> = OnceLock::new();
static QUOTA_EFFECT: OnceLock<Mutex<QuotaEffect>> = OnceLock::new();

#[derive(Clone, Copy)]
struct QuotaEffect { active: bool, period: f64, x: f64, y: f64 }

fn quota_effect_state() -> &'static Mutex<QuotaEffect> {
    QUOTA_EFFECT.get_or_init(|| Mutex::new(QuotaEffect { active: false, period: 3.2, x: 0.0, y: 0.0 }))
}

fn sync_quota_effect(main: &WebviewWindow) -> Result<(), String> {
    let state = *quota_effect_state().lock().map_err(|e| e.to_string())?;
    let Some(fx) = main.app_handle().get_webview_window("quota-fx") else { return Ok(()); };
    let expanded = main.outer_size().map_err(|e| e.to_string())?.width > 240;
    let active = state.active && expanded && main.is_visible().unwrap_or(false) && !main.is_minimized().unwrap_or(false);
    fx.eval(format!("document.documentElement.dataset.flowing='{}';document.documentElement.style.setProperty('--coin-period','{}s')", active, state.period)).map_err(|e| e.to_string())?;
    if !active { return fx.hide().map_err(|e| e.to_string()); }
    let position = main.outer_position().map_err(|e| e.to_string())?;
    let scale = main.scale_factor().map_err(|e| e.to_string())?;
    fx.set_position(PhysicalPosition::new(position.x + ((state.x - 48.0) * scale).round() as i32, position.y + ((state.y - 58.0) * scale).round() as i32)).map_err(|e| e.to_string())?;
    fx.show().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_quota_effect(window: WebviewWindow, active: bool, period: f64, anchor_x: f64, anchor_y: f64) -> Result<(), String> {
    if window.label() != "main" || ![period, anchor_x, anchor_y].iter().all(|n| n.is_finite()) { return Err("Invalid quota effect".into()); }
    *quota_effect_state().lock().map_err(|e| e.to_string())? = QuotaEffect { active, period: period.clamp(0.9, 3.2), x: anchor_x.clamp(0.0, COMPACT_WIDTH), y: anchor_y.clamp(0.0, 80.0) };
    sync_quota_effect(&window)
}

struct BackendProcess(Mutex<Option<Child>>);
impl BackendProcess {
    fn stop(&self) {
        let Ok(mut child) = self.0.lock() else {
            return;
        };
        let Some(process) = child.take() else {
            return;
        };
        stop_backend_process(process);
    }
}

fn stop_backend_process(mut process: Child) {
    #[cfg(unix)]
    {
        // Each backend is spawned in its own process group. Include PyInstaller's
        // worker and the observer's Codex children, while leaving the user's app alone.
        let group = -(process.id() as i32);
        unsafe { libc::kill(group, libc::SIGTERM); }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(process.try_wait(), Ok(Some(_))) { break; }
            thread::sleep(Duration::from_millis(50));
        }
        unsafe { libc::kill(group, libc::SIGKILL); }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &process.id().to_string(), "/T", "/F"])
            .creation_flags(0x08000000).output();
    }
    let _ = process.kill();
    let _ = process.wait();
}

fn compact_height(height: Option<f64>) -> f64 {
    height.filter(|value| value.is_finite()).unwrap_or(COMPACT_HEIGHT).clamp(180.0, COMPACT_HEIGHT)
}

#[tauri::command]
fn set_pet_view(window: WebviewWindow, view: String, height: Option<f64>) -> Result<(), String> {
    let (width, height) = match view.as_str() {
        "collapsed" => (COLLAPSED_WIDTH, COLLAPSED_HEIGHT),
        "compact" => (COMPACT_WIDTH, compact_height(height)),
        _ => return Err("窗口模式无效".to_string()),
    };
    resize_window(&window, width, height)
}

#[tauri::command]
fn start_window_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn show_pet_menu(window: tauri::Window, x: f64, y: f64) -> Result<(), String> {
    let app = window.app_handle();
    let toggle = MenuItemBuilder::with_id("pet-toggle", "展开 / 收起")
        .build(app)
        .map_err(|error| error.to_string())?;
    let quit = MenuItemBuilder::with_id("pet-quit", "退出 Monkex")
        .build(app)
        .map_err(|error| error.to_string())?;
    let menu = MenuBuilder::new(app)
        .items(&[&toggle, &quit])
        .build()
        .map_err(|error| error.to_string())?;
    let cache = CONTEXT_MENU.get_or_init(|| Mutex::new(None));
    let mut cached = cache
        .lock()
        .map_err(|_| "Monkex 菜单状态损坏".to_string())?;
    *cached = Some(menu);
    let Some(menu) = cached.as_ref() else {
        return Err("Monkex 菜单不可用".to_string());
    };
    window
        .popup_menu_at(menu, LogicalPosition::new(x.max(0.0), y.max(0.0)))
        .map_err(|error| error.to_string())
}

fn work_twin_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .components()
        .collect()
}

fn backend_address() -> SocketAddr {
    SocketAddr::from_str(&format!("{BACKEND_HOST}:{BACKEND_PORT}"))
        .expect("valid work twin backend address")
}

fn backend_is_ready() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&backend_address(), Duration::from_millis(220))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(420)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(220)));
    if stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:8766\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok()
        && response.contains("200 OK")
        && response.contains("\"execution_mode\":\"codex_supervised\"")
}

fn start_backend(app: &tauri::AppHandle) -> Result<Option<Child>, String> {
    if backend_is_ready() {
        return Ok(None);
    }
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let log_path = data_dir.join("backend.log");
    let stdout = File::create(&log_path).map_err(|error| error.to_string())?;
    let stderr = stdout.try_clone().map_err(|error| error.to_string())?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let sidecar = executable.parent().ok_or("Application directory unavailable")?
        .join(if cfg!(windows) { "monkex-backend.exe" } else { "monkex-backend" });
    let mut command = if sidecar.is_file() {
        let mut command = Command::new(sidecar);
        let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
        command.env("MONKEX_STATIC_ROOT", resources.join("web"));
        command.env("MONKEX_DATA_DIR", &data_dir);
        command
    } else if cfg!(debug_assertions) {
        let root = work_twin_root();
        let mut command = Command::new(if cfg!(windows) { "python" } else { "python3" });
        command.arg("-B").arg(root.join("scripts/work_twin_shell.py"));
        command.current_dir(&root);
        // Keep this checkout's existing read receipts during development.
        command
    } else {
        return Err("Monkex 安装包缺少后端，请重新安装完整版本".to_string());
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .args(["--port", "8766"])
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| format!("无法启动 Monkex 后端：{error}"))?;
    // Frozen sidecars can need extra time for first-run extraction and OS checks.
    // Readiness and early process exit remain the authority, with a bounded deadline.
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if backend_is_ready() {
            return Ok(Some(child));
        }
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Err(format!(
                "Monkex 后端启动失败，日志：{}",
                log_path.display()
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
    stop_backend_process(child);
    Err(format!(
        "Monkex 后端启动超时，日志：{}",
        log_path.display()
    ))
}

fn set_window_mode(window: &WebviewWindow, expanded: bool) -> Result<(), String> {
    let (width, height) = if expanded {
        (COMPACT_WIDTH, COMPACT_HEIGHT)
    } else {
        (COLLAPSED_WIDTH, COLLAPSED_HEIGHT)
    };
    resize_window(window, width, height)
}

fn resize_window(window: &WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    if width == COLLAPSED_WIDTH {
        if let Ok(mut state) = quota_effect_state().lock() { state.active = false; }
        let _ = sync_quota_effect(window);
    }
    let old_position = window.outer_position().map_err(|error| error.to_string())?;
    let old_size = window.outer_size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    let right = old_position.x + old_size.width as i32;
    let bottom = old_position.y + old_size.height as i32;
    let new_width = (width * scale).round() as i32;
    let new_height = (height * scale).round() as i32;
    let mut x = right - new_width;
    let mut y = bottom - new_height;
    if let Ok(Some(monitor)) = window.current_monitor() {
        let area = monitor.work_area();
        let left = area.position.x;
        let top = area.position.y;
        let max_x = left + area.size.width as i32 - new_width;
        let max_y = top + area.size.height as i32 - new_height;
        x = x.clamp(left, max_x.max(left));
        y = y.clamp(top, max_y.max(top));
    }
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn position_initial_window(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let area = monitor.work_area();
    let margin = (WINDOW_MARGIN * monitor.scale_factor()).round() as i32;
    let x = area.position.x + area.size.width as i32 - size.width as i32 - margin;
    let y = area.position.y + area.size.height as i32 - size.height as i32 - margin;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn configure_window(window: &WebviewWindow) {
    let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));
    let _ = window.set_shadow(false);
    let _ = window.set_always_on_top(true);
    position_initial_window(window);
}

fn toggle_from_menu(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let expanded = window
        .outer_size()
        .map(|size| size.width < 240)
        .unwrap_or(true);
    let _ = set_window_mode(&window, expanded);
    let script = format!(
        "window.dispatchEvent(new CustomEvent('work-twin-pet-mode', {{ detail: {{ expanded: {} }} }}))",
        expanded
    );
    let _ = window.eval(&script);
}

pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            set_pet_view,
            start_window_drag,
            show_pet_menu,
            set_quota_effect
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let child = start_backend(app.handle())?;
            app.manage(BackendProcess(Mutex::new(child)));
            let config = app
                .config()
                .app
                .windows
                .first()
                .ok_or("Monkex 窗口配置不存在")?
                .clone();
            let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)
                .map_err(|error| error.to_string())?
                .build()
                .map_err(|error| error.to_string())?;
            configure_window(&window);
            // A separate visual-only window preserves the board's native hit bounds.
            // The whole effect window ignores input; no global cursor polling is used.
            let fx = tauri::WebviewWindowBuilder::new(app, "quota-fx", tauri::WebviewUrl::External("http://127.0.0.1:8766/shell/coin-overlay.html".parse()?))
                .title("Monkex Coins").inner_size(96.0, 64.0).decorations(false)
                .transparent(true).shadow(false).always_on_top(true).skip_taskbar(true)
                .focused(false).focusable(false).visible(false).resizable(false).build()?;
            fx.set_ignore_cursor_events(true)?;
            let tracking = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Main-window close owns the application lifecycle, including
                    // the visual-only window and the observer's process tree.
                    api.prevent_close();
                    tracking.app_handle().exit(0);
                    return;
                }
                if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }) {
                    let _ = sync_quota_effect(&tracking);
                }
            });
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "pet-toggle" => toggle_from_menu(app),
                "pet-quit" => app.exit(0),
                _ => {}
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Monkex");

    app.run(|app, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            if let Some(backend) = app.try_state::<BackendProcess>() {
                backend.stop();
            }
        }
        #[cfg(target_os = "macos")]
        if matches!(event, tauri::RunEvent::Reopen { .. }) {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = set_window_mode(&window, true);
                let _ = window.eval(
                    "window.dispatchEvent(new CustomEvent('work-twin-pet-mode', { detail: { expanded: true } }))",
                );
                let _ = window.set_focus();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compact_size_is_bounded_and_defaults_to_dense_board() {
        assert_eq!(compact_height(None), 420.0);
        assert_eq!(compact_height(Some(f64::NAN)), 420.0);
        assert_eq!(compact_height(Some(f64::INFINITY)), 420.0);
        assert_eq!(compact_height(Some(-10.0)), 180.0);
        assert_eq!(compact_height(Some(230.0)), 230.0);
        assert_eq!(compact_height(Some(1000.0)), 420.0);
    }
}
