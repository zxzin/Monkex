use std::fs::File;
use std::collections::HashMap;
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
use serde::{Deserialize, Serialize};

const BACKEND_HOST: &str = "127.0.0.1";
const BACKEND_PORT: u16 = 8766;
const COLLAPSED_WIDTH: f64 = 76.0;
const COLLAPSED_HEIGHT: f64 = 76.0;
const COMPACT_WIDTH: f64 = 344.0;
const COMPACT_HEIGHT: f64 = 420.0;
const WINDOW_MARGIN: f64 = 18.0;
const REMINDER_WIDTH: f64 = 196.0;

static CONTEXT_MENU: OnceLock<Mutex<Option<Menu<tauri::Wry>>>> = OnceLock::new();

#[derive(Clone, Deserialize, Serialize, PartialEq)]
struct InputReminder {
    thread_id: String,
    turn_id: String,
    question_id: String,
    title: String,
    count: u32,
    available: bool,
}

#[derive(Default)]
struct ReminderData {
    items: Vec<InputReminder>,
    lang: String,
    revision: u64,
    received: Option<Instant>,
    confirmed: HashMap<(String, String, String), Instant>,
    dismissed: HashMap<(String, String, String), (u32, Instant)>,
    pressed_at: Option<Instant>,
    page: usize,
    width: Option<f64>,
}

fn reminder_key(item: &InputReminder) -> (String, String, String) {
    (item.thread_id.clone(), item.turn_id.clone(), item.question_id.clone())
}

impl ReminderData {
    fn held(&self) -> bool {
        self.pressed_at.is_some_and(|at| at.elapsed() < Duration::from_secs(5))
    }
    fn accept(&mut self, items: &[InputReminder], now: Instant) {
        // Additional questions in the same pending group deserve a fresh notification.
        self.dismissed.retain(|key, (count, _)| !items.iter().any(|item| reminder_key(item) == *key && item.count > *count));
        self.confirmed.retain(|key, _| items.iter().any(|item| reminder_key(item) == *key));
        for item in items {
            let at = self.confirmed.entry(reminder_key(item)).or_insert(now);
            if item.available { *at = now; }
        }
        // Repeated unavailable snapshots retain their original grace deadline.
        self.items = items.iter().filter(|item| !self.dismissed.contains_key(&reminder_key(item))
            && (item.available || self.confirmed
            .get(&reminder_key(item)).is_some_and(|at| now.duration_since(*at) < Duration::from_secs(120))))
            .cloned().collect();
        self.page = self.page.min(self.items.len().saturating_sub(1) / 3);
        self.received = Some(now);
    }
    fn dismiss(&mut self, key: (String, String, String), count: u32, now: Instant) {
        // Session-only navigation receipts suppress the exact prompt across polling gaps.
        self.dismissed.insert(key.clone(), (count, now));
        if self.dismissed.len() > 256 {
            if let Some(oldest) = self.dismissed.iter().min_by_key(|(_, (_, at))| *at).map(|(key, _)| key.clone()) {
                self.dismissed.remove(&oldest);
            }
        }
        self.items.retain(|item| reminder_key(item) != key || item.count > count);
        self.page = self.page.min(self.items.len().saturating_sub(1) / 3);
        self.revision = self.revision.wrapping_add(1);
    }
}

#[derive(Default)]
struct ReminderStore {
    data: Mutex<ReminderData>,
    window_update: Mutex<()>,
}

#[derive(Serialize)]
struct ReminderSnapshot {
    items: Vec<InputReminder>,
    lang: String,
    revision: u64,
    stale: bool,
    page: usize,
}

fn reminder_height(count: usize) -> f64 {
    reminder_page_height(count, 0)
}

fn reminder_width(width: Option<f64>) -> f64 {
    width.filter(|value| value.is_finite()).map(|value| value.ceil().clamp(152.0, REMINDER_WIDTH)).unwrap_or(REMINDER_WIDTH)
}

fn reminder_page_height(count: usize, page: usize) -> f64 {
    let page = page.min(count.saturating_sub(1) / 3);
    let visible = count.saturating_sub(page * 3).min(3);
    12.0 + visible as f64 * 52.0 + if count > 3 { 26.0 } else { 0.0 }
}

fn reminder_context_allowed(label: &str, url: &tauri::Url) -> bool {
    label == "input-reminders" && url.scheme() == "http" && url.host_str() == Some(BACKEND_HOST)
        && url.port() == Some(BACKEND_PORT) && url.path() == "/shell/reminders.html"
}

fn validate_reminder_window(window: &WebviewWindow) -> Result<(), String> {
    // Native IPC supplies an origin without a path to ACL; enforce the page here.
    if !reminder_context_allowed(window.label(), &window.url().map_err(|e| e.to_string())?) {
        return Err("Reminder window required".into());
    }
    Ok(())
}

fn valid_reminder(item: &InputReminder) -> bool {
    !item.thread_id.is_empty() && item.thread_id.len() <= 100
        && item.thread_id.bytes().all(|v| v.is_ascii_alphanumeric() || v == b'-' || v == b'_')
        && (!item.available || (!item.turn_id.is_empty() && !item.question_id.is_empty()))
        && item.turn_id.len() <= 256 && item.question_id.len() <= 1024
        && item.title.chars().count() <= 160 && (1..=4096).contains(&item.count)
        && !item.turn_id.chars().any(char::is_control)
        && !item.question_id.chars().any(char::is_control)
        && !item.title.chars().any(char::is_control)
}

// Anchor notifications above the tree/board, with all coordinates in physical pixels.
fn reminder_origin(anchor: (i32, i32, i32, i32), area: (i32, i32, i32, i32), size: (i32, i32), gap: i32) -> (i32, i32) {
    let (ax, ay, aw, ah) = anchor;
    let (left, top, width, height) = area;
    let (w, h) = size;
    let right = left + width;
    let bottom = top + height;
    let centered_x = ax + (aw - w) / 2;
    let (x, y) = if ay - gap - h >= top {
        (centered_x, ay - gap - h)
    } else if ay + ah + gap + h <= bottom {
        (centered_x, ay + ah + gap)
    } else if ax - gap - w >= left {
        (ax - gap - w, ay + ah - h)
    } else if ax + aw + gap + w <= right {
        (ax + aw + gap, ay + ah - h)
    } else {
        (centered_x, ay - gap - h)
    };
    (x.clamp(left, (right - w).max(left)), y.clamp(top, (bottom - h).max(top)))
}

fn position_input_reminders(app: &tauri::AppHandle) -> Result<(), String> {
    if app.state::<ReminderStore>().data.lock().map_err(|_| "Reminder state unavailable")?.held() { return Ok(()); }
    let (Some(main), Some(bubble)) = (app.get_webview_window("main"), app.get_webview_window("input-reminders")) else { return Ok(()); };
    let scale = main.scale_factor().map_err(|e| e.to_string())?;
    let pos = main.outer_position().map_err(|e| e.to_string())?;
    let size = main.outer_size().map_err(|e| e.to_string())?;
    let bubble_size = bubble.outer_size().map_err(|e| e.to_string())?;
    if let Some(monitor) = main.current_monitor().map_err(|e| e.to_string())? {
        let area = monitor.work_area();
        let (x, y) = reminder_origin(
            (pos.x, pos.y, size.width as i32, size.height as i32),
            (area.position.x, area.position.y, area.size.width as i32, area.size.height as i32),
            (bubble_size.width as i32, bubble_size.height as i32), (8.0 * scale).round() as i32);
        let target = PhysicalPosition::new(x, y);
        if bubble.outer_position().map_err(|e| e.to_string())? != target {
            bubble.set_position(target).map_err(|e| e.to_string())?;
        }
        let bubble_scale = bubble.scale_factor().map_err(|e| e.to_string())?;
        let tail_x = ((pos.x as f64 + size.width as f64 / 2.0 - x as f64) / bubble_scale - 6.0)
            .clamp(12.0, bubble_size.width as f64 / bubble_scale - 24.0);
        // Numeric coordinates keep the tail aimed at the tree after edge clamping.
        let anchor = if y >= pos.y + size.height as i32 { "below" } else { "above" };
        let _ = bubble.eval(&format!("document.documentElement.style.setProperty('--reminder-tail-x','{tail_x:.1}px');document.documentElement.dataset.anchor='{anchor}'"));
    }
    Ok(())
}

fn notify_shared_focus(app: &tauri::AppHandle, focused: bool) {
    let app = app.clone();
    if focused {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.eval("window.dispatchEvent(new CustomEvent('work-twin-window-focus',{detail:{focused:true}}))");
        }
        return;
    }
    // Focus transfer between the two local windows settles before evaluating external blur.
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(80));
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let inside = ["main", "input-reminders"].iter().any(|label|
                handle.get_webview_window(label).is_some_and(|w| w.is_focused().unwrap_or(false)));
            if !inside {
                if let Some(main) = handle.get_webview_window("main") {
                    let _ = main.eval("window.dispatchEvent(new CustomEvent('work-twin-window-focus',{detail:{focused:false}}))");
                }
            }
        });
    });
}

#[tauri::command]
async fn sync_input_reminders(window: WebviewWindow, items: Vec<InputReminder>, lang: Option<String>) -> Result<(), String> {
    if window.label() != "main" || items.len() > 32 || !items.iter().all(valid_reminder) {
        return Err("Invalid reminder snapshot".into());
    }
    let app = window.app_handle();
    let store = app.state::<ReminderStore>();
    let _window_update = store.window_update.lock().map_err(|_| "Reminder window unavailable")?;
    let lang = if lang.as_deref().is_some_and(|v| v.starts_with("en")) { "en" } else { "zh" };
    let (count, page, width, held) = {
        let mut data = store.data.lock().map_err(|_| "Reminder state unavailable")?;
        data.revision = data.revision.wrapping_add(1);
        data.accept(&items, Instant::now());
        data.lang = lang.into();
        (data.items.len(), data.page, reminder_width(data.width), data.held())
    };
    if held { return Ok(()); }
    if count == 0 {
        if let Some(bubble) = app.get_webview_window("input-reminders") { let _ = bubble.hide(); }
        return Ok(());
    }
    let bubble = if let Some(existing) = app.get_webview_window("input-reminders") { existing } else {
        let url = format!("http://127.0.0.1:8766/shell/reminders.html?lang={lang}").parse().map_err(|_| "Invalid reminder URL")?;
        let bubble = tauri::WebviewWindowBuilder::new(app, "input-reminders", tauri::WebviewUrl::External(url))
            .title("Monkex · Replies").inner_size(width, reminder_height(count))
            .resizable(false).decorations(false).transparent(true).shadow(false)
            .always_on_top(true).skip_taskbar(true).focused(false).visible(false).accept_first_mouse(true)
            .build().map_err(|e| e.to_string())?;
        let handle = app.clone();
        bubble.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(focused) = event { notify_shared_focus(&handle, *focused); }
            if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }) {
                let _ = position_input_reminders(&handle);
            }
        });
        bubble
    };
    let expected = LogicalSize::new(width, reminder_page_height(count, page));
    let actual = bubble.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(bubble.scale_factor().map_err(|e| e.to_string())?);
    if (actual.width - expected.width).abs() > 1.0 || (actual.height - expected.height).abs() > 1.0 {
        bubble.set_size(expected).map_err(|e| e.to_string())?;
    }
    position_input_reminders(app)?;
    if !bubble.is_visible().map_err(|e| e.to_string())? { bubble.show().map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
fn get_input_reminders(window: WebviewWindow) -> Result<ReminderSnapshot, String> {
    validate_reminder_window(&window)?;
    let store = window.app_handle().state::<ReminderStore>();
    let data = store.data.lock().map_err(|_| "Reminder state unavailable")?;
    let age = data.received.map(|at| at.elapsed().as_secs()).unwrap_or(u64::MAX);
    let mut items = if age > 120 { Vec::new() } else { data.items.clone() };
    if age > 30 { for item in &mut items { item.available = false; } }
    if items.is_empty() && !data.held() { let _ = window.hide(); }
    Ok(ReminderSnapshot { items, lang: data.lang.clone(), revision: data.revision, stale: age > 30, page: data.page })
}

// Window serialization stays off the UI thread, which must service native getters.
#[tauri::command]
async fn set_input_reminder_interaction(window: WebviewWindow, active: bool) -> Result<(), String> {
    validate_reminder_window(&window)?;
    let app = window.app_handle();
    let store = app.state::<ReminderStore>();
    let _window_update = store.window_update.lock().map_err(|_| "Reminder window unavailable")?;
    let (count, page, width) = {
        let mut data = store.data.lock().map_err(|_| "Reminder state unavailable")?;
        data.pressed_at = if active { Some(Instant::now()) } else { None };
        (data.items.len(), data.page, reminder_width(data.width))
    };
    if !active {
        if count == 0 { let _ = window.hide(); }
        else {
            window.set_size(LogicalSize::new(width, reminder_page_height(count, page))).map_err(|e| e.to_string())?;
            position_input_reminders(app)?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn set_input_reminder_page(window: WebviewWindow, page: usize, width: Option<f64>) -> Result<(), String> {
    validate_reminder_window(&window)?;
    let app = window.app_handle();
    let store = app.state::<ReminderStore>();
    let _window_update = store.window_update.lock().map_err(|_| "Reminder window unavailable")?;
    let (count, page, width, held) = {
        let mut data = store.data.lock().map_err(|_| "Reminder state unavailable")?;
        data.page = page.min(data.items.len().saturating_sub(1) / 3);
        if width.is_some() { data.width = Some(reminder_width(width)); }
        (data.items.len(), data.page, reminder_width(data.width), data.held())
    };
    if !held && count > 0 {
        window.set_size(LogicalSize::new(width, reminder_page_height(count, page))).map_err(|e| e.to_string())?;
        position_input_reminders(app)?;
    }
    Ok(())
}

#[tauri::command]
async fn dismiss_input_reminder(window: WebviewWindow, thread_id: String, turn_id: String, question_id: String, count: u32) -> Result<(), String> {
    validate_reminder_window(&window)?;
    let target = InputReminder { thread_id, turn_id, question_id, title: String::new(), count, available: true };
    if !valid_reminder(&target) { return Err("Invalid reminder target".into()); }
    let app = window.app_handle();
    let store = app.state::<ReminderStore>();
    let _window_update = store.window_update.lock().map_err(|_| "Reminder window unavailable")?;
    let (count, page, width, held) = {
        let mut data = store.data.lock().map_err(|_| "Reminder state unavailable")?;
        data.dismiss(reminder_key(&target), count, Instant::now());
        (data.items.len(), data.page, reminder_width(data.width), data.held())
    };
    if !held {
        if count == 0 { window.hide().map_err(|e| e.to_string())?; }
        else {
            window.set_size(LogicalSize::new(width, reminder_page_height(count, page))).map_err(|e| e.to_string())?;
            position_input_reminders(app)?;
        }
    }
    Ok(())
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

fn pointer_in_bounds(cursor: PhysicalPosition<f64>, origin: PhysicalPosition<i32>, size: tauri::PhysicalSize<u32>) -> bool {
    cursor.x >= origin.x as f64 && cursor.y >= origin.y as f64
        && cursor.x < origin.x as f64 + size.width as f64
        && cursor.y < origin.y as f64 + size.height as f64
}

#[tauri::command]
fn pet_pointer_inside(window: WebviewWindow) -> Result<bool, String> {
    // Desktop coordinates work for inactive windows and across monitor scales.
    // Only membership in our visible window crosses the IPC boundary.
    if !window.is_visible().map_err(|error| error.to_string())? { return Ok(false); }
    let inside = pointer_in_bounds(
        window.cursor_position().map_err(|error| error.to_string())?,
        window.inner_position().map_err(|error| error.to_string())?,
        window.inner_size().map_err(|error| error.to_string())?,
    );
    if inside { return Ok(true); }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let expanded = window.inner_size().map_err(|e| e.to_string())?.width as f64 / scale > COLLAPSED_WIDTH + 1.0;
    // An independent bubble keeps an expanded board stable without expanding a collapsed tree.
    if expanded {
        if let Some(bubble) = window.app_handle().get_webview_window("input-reminders") {
            if bubble.is_visible().unwrap_or(false) {
                return Ok(pointer_in_bounds(bubble.cursor_position().map_err(|e| e.to_string())?,
                    bubble.inner_position().map_err(|e| e.to_string())?, bubble.inner_size().map_err(|e| e.to_string())?));
            }
        }
    }
    Ok(false)
}

#[tauri::command]
fn set_pet_view(window: WebviewWindow, view: String, height: Option<f64>, activate: Option<bool>) -> Result<(), String> {
    let (width, height) = match view.as_str() {
        "collapsed" => (COLLAPSED_WIDTH, COLLAPSED_HEIGHT),
        "compact" => (COMPACT_WIDTH, compact_height(height)),
        _ => return Err("窗口模式无效".to_string()),
    };
    // Acquire focus when opening the tree, while ordinary feed resizes leave
    // the user's active application unchanged.
    let was_collapsed = window.inner_size().map_err(|error| error.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|error| error.to_string())?)
        .width <= COLLAPSED_WIDTH + 1.0;
    resize_window(&window, width, height)?;
    if view == "compact" && was_collapsed && activate.unwrap_or(true) {
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn start_window_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn move_pet_window(window: WebviewWindow, dx: f64, dy: f64) -> Result<(), String> {
    if !dx.is_finite() || !dy.is_finite() {
        return Err("拖动位移无效".to_string());
    }
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    window.set_position(PhysicalPosition::new(
        position.x + (dx * scale).round() as i32,
        position.y + (dy * scale).round() as i32,
    )).map_err(|error| error.to_string())
}

#[tauri::command]
fn show_pet_menu(window: tauri::Window, x: f64, y: f64, lang: Option<String>) -> Result<(), String> {
    let app = window.app_handle();
    let english = lang.as_deref().is_some_and(|value| value.starts_with("en"));
    let toggle = MenuItemBuilder::with_id("pet-toggle", if english { "Expand / Collapse" } else { "展开 / 收起" })
        .build(app)
        .map_err(|error| error.to_string())?;
    let quit = MenuItemBuilder::with_id("pet-quit", if english { "Quit Monkex" } else { "退出 Monkex" })
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
            pet_pointer_inside,
            start_window_drag,
            move_pet_window,
            show_pet_menu,
            sync_input_reminders,
            get_input_reminders,
            set_input_reminder_interaction,
            set_input_reminder_page,
            dismiss_input_reminder
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let child = start_backend(app.handle())?;
            app.manage(BackendProcess(Mutex::new(child)));
            app.manage(ReminderStore::default());
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
            let event_app = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(focused) = event {
                    notify_shared_focus(&event_app, *focused);
                }
                if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }) {
                    let _ = position_input_reminders(&event_app);
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
    fn reminder_dimensions_and_screen_placement_are_bounded() {
        assert_eq!(reminder_height(1), 64.0);
        assert_eq!(reminder_height(3), 168.0);
        assert_eq!(reminder_height(32), 194.0);
        assert_eq!(reminder_page_height(4, 1), 90.0);
        assert_eq!(reminder_page_height(5, 1), 142.0);
        assert_eq!(reminder_page_height(1, 9), 64.0);
        assert_eq!(REMINDER_WIDTH, 196.0);
        assert_eq!(reminder_origin((1300,700,76,76),(0,0,1440,900),(196,64),8),(1240,628));
        assert_eq!(reminder_origin((-1400,100,152,152),(-1440,0,1440,900),(392,128),16),(-1440,268));
        assert_eq!(reminder_origin((1360,700,76,76),(0,0,1440,900),(196,64),8),(1244,628));
        assert_eq!(reminder_origin((100,20,76,76),(0,0,1440,900),(196,64),8),(40,104));
        assert_eq!(reminder_origin((600,300,76,76),(0,0,1440,900),(196,194),8),(540,98));
        let origin = reminder_origin((0,0,344,420),(0,0,400,500),(236,230),8);
        assert!(origin.0 >= 0 && origin.0 + 236 <= 400);
        assert!(origin.1 >= 0 && origin.1 + 230 <= 500);
    }
    #[test]
    fn reminder_content_width_preserves_compact_bounds() {
        assert_eq!(reminder_width(None), 196.0);
        assert_eq!(reminder_width(Some(152.0)), 152.0);
        assert_eq!(reminder_width(Some(171.2)), 172.0);
        assert_eq!(reminder_width(Some(0.0)), 152.0);
        assert_eq!(reminder_width(Some(900.0)), 196.0);
        assert_eq!(reminder_width(Some(f64::NAN)), 196.0);
        assert_eq!(reminder_width(Some(f64::INFINITY)), 196.0);
        assert_eq!(reminder_origin((1300,700,76,76),(0,0,1440,900),(152,64),8),(1262,628));
    }
    #[test]
    fn reminder_metadata_has_bounded_identifiers_and_text() {
        let mut item = InputReminder { thread_id: "thread-1".into(), turn_id: "turn-1".into(),
            question_id: "[\"request_user_input_async\",\"call_1\",0]".into(), title: "A task".into(), count: 1, available: true };
        assert!(valid_reminder(&item));
        item.thread_id = "../thread".into(); assert!(!valid_reminder(&item));
        item.thread_id = "thread-1".into(); item.title = "x".repeat(161); assert!(!valid_reminder(&item));
        item.title = "A task".into(); item.count = 0; assert!(!valid_reminder(&item));
        item.count = 1; item.question_id = "x\n".into(); assert!(!valid_reminder(&item));
        item.available = false; item.question_id.clear(); item.turn_id.clear(); assert!(valid_reminder(&item));
        item.available = true; assert!(!valid_reminder(&item));
    }
    #[test]
    fn unavailable_reminders_expire_without_extending_on_repeated_syncs() {
        let now = Instant::now();
        let mut data = ReminderData::default();
        let mut item = InputReminder { thread_id: "thread-1".into(), turn_id: "turn-1".into(),
            question_id: "question-1".into(), title: "A task".into(), count: 1, available: true };
        data.accept(&[item.clone()], now);
        item.available = false;
        data.accept(&[item.clone()], now + Duration::from_secs(100));
        assert_eq!(data.items.len(), 1);
        data.accept(&[item.clone()], now + Duration::from_secs(121));
        assert!(data.items.is_empty());
        data.accept(&[item.clone()], now + Duration::from_secs(126));
        assert!(data.items.is_empty());
        item.available = true;
        data.accept(&[item], now + Duration::from_secs(130));
        assert_eq!(data.items.len(), 1);
        data.accept(&[], now + Duration::from_secs(131));
        assert!(data.items.is_empty()); assert!(data.confirmed.is_empty());
    }
    #[test]
    fn reminder_press_guard_is_bounded_and_released() {
        let mut data = ReminderData::default();
        data.pressed_at = Some(Instant::now()); assert!(data.held());
        data.pressed_at = Some(Instant::now() - Duration::from_secs(6)); assert!(!data.held());
        data.pressed_at = None; assert!(!data.held());
    }
    #[test]
    fn opened_prompt_stays_hidden_and_new_targets_remain_visible() {
        let now = Instant::now();
        let mut data = ReminderData::default();
        let item = InputReminder { thread_id: "task-1".into(), turn_id: "turn-1".into(),
            question_id: "question-1".into(), title: "Task".into(), count: 1, available: true };
        let other = InputReminder { thread_id: "task-2".into(), ..item.clone() };
        data.accept(&[item.clone(), other.clone()], now);
        data.dismiss(reminder_key(&item), 1, now);
        assert_eq!(data.items.len(), 1);
        assert_eq!(data.items[0].thread_id, "task-2");
        data.accept(&[], now + Duration::from_secs(1));
        data.accept(&[item.clone(), other], now + Duration::from_secs(2));
        assert_eq!(data.items.len(), 1, "an empty polling gap preserves dismissal");
        let newer = InputReminder { question_id: "question-2".into(), ..item.clone() };
        data.accept(&[newer.clone()], now + Duration::from_secs(3));
        assert_eq!(data.items[0].question_id, "question-2");
        data.dismiss(reminder_key(&item), 1, now + Duration::from_secs(4));
        assert_eq!(data.items[0].question_id, "question-2", "a late old navigation cannot dismiss a new question");
        data.dismiss(reminder_key(&newer), 1, now + Duration::from_secs(5));
        assert!(data.items.is_empty());
        let new_turn = InputReminder { turn_id: "turn-2".into(), ..item };
        data.accept(&[new_turn], now + Duration::from_secs(6));
        assert_eq!(data.items.len(), 1);
        assert_eq!(data.page, 0);
    }
    #[test]
    fn reminder_dismissals_have_bounded_session_memory_and_clamp_pages() {
        let now = Instant::now();
        let mut data = ReminderData::default();
        let items: Vec<InputReminder> = (0..4).map(|n| InputReminder { thread_id: format!("task-{n}"),
            turn_id: "turn".into(), question_id: "question".into(), title: "Task".into(), count: 1, available: true }).collect();
        data.accept(&items, now); data.page = 1;
        data.dismiss(reminder_key(&items[3]), 1, now);
        assert_eq!(data.page, 0);
        for n in 0..300 {
            data.dismiss((format!("other-{n}"), "turn".into(), "question".into()), 1, now + Duration::from_millis(n));
        }
        assert_eq!(data.dismissed.len(), 256);
    }
    #[test]
    fn additional_questions_reopen_a_group_without_late_click_suppression() {
        let now = Instant::now();
        let mut data = ReminderData::default();
        let item = InputReminder { thread_id: "task".into(), turn_id: "turn".into(),
            question_id: "question".into(), title: "Task".into(), count: 1, available: true };
        data.accept(&[item.clone()], now);
        data.dismiss(reminder_key(&item), 1, now);
        let expanded = InputReminder { count: 2, ..item.clone() };
        data.accept(&[expanded.clone()], now + Duration::from_secs(1));
        assert_eq!(data.items.len(), 1);
        assert!(!data.dismissed.contains_key(&reminder_key(&item)));
        data.dismiss(reminder_key(&item), 1, now + Duration::from_secs(2));
        assert_eq!(data.items[0].count, 2, "a late click on the smaller group preserves the new question");
        data.accept(&[expanded.clone()], now + Duration::from_secs(3));
        assert_eq!(data.items.len(), 1);
        data.dismiss(reminder_key(&expanded), 2, now + Duration::from_secs(4));
        assert!(data.items.is_empty());
    }
    #[test]
    fn reminder_commands_require_the_exact_local_page_and_window() {
        let url = tauri::Url::parse("http://127.0.0.1:8766/shell/reminders.html?lang=en").unwrap();
        assert!(reminder_context_allowed("input-reminders", &url));
        assert!(!reminder_context_allowed("main", &url));
        for value in ["http://127.0.0.1:8766/shell/index.html", "http://127.0.0.1:8786/shell/reminders.html", "https://example.com/shell/reminders.html"] {
            assert!(!reminder_context_allowed("input-reminders", &tauri::Url::parse(value).unwrap()));
        }
    }
    #[test]
    fn pointer_membership_uses_physical_bounds_and_excludes_far_edges() {
        let origin=PhysicalPosition::new(-600, 200);
        let size=tauri::PhysicalSize::new(152, 152);
        assert!(pointer_in_bounds(PhysicalPosition::new(-600.0,200.0),origin,size));
        assert!(pointer_in_bounds(PhysicalPosition::new(-500.0,300.0),origin,size));
        assert!(!pointer_in_bounds(PhysicalPosition::new(-448.0,300.0),origin,size));
        assert!(!pointer_in_bounds(PhysicalPosition::new(-500.0,352.0),origin,size));
        assert!(!pointer_in_bounds(PhysicalPosition::new(-601.0,300.0),origin,size));
        assert!(!pointer_in_bounds(PhysicalPosition::new(f64::NAN,300.0),origin,size));
    }
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
