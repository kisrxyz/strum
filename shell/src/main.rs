// Strum's own window (Tauri 2, WebView2) — the installed app.
//
// The page, the songs and the amp are the same as in the author's copy; only how they start differs.
// This program:
// 1. shows a small start screen (splash/index.html) at once;
// 2. on the first launch (or after an update) has uv put Python 3.12 and the service's base packages
//    into %LOCALAPPDATA%\app.strum\env — the neural networks come later, from inside the app;
// 3. picks two free ports and starts the song service (which also serves the page) and the guitar
//    engine, both inside a Windows job object, so they end when this window ends, even on a crash;
// 4. turns the window to the page once the service answers.
//
// Where things live: the program (uv.exe, app/ = the service's code, web/ = the built page) in the
// install folder; Python, its packages, the download cache, the neural networks, the logs and
// everything Python compiles while it runs (.pyc, Numba's cache) in %LOCALAPPDATA%\app.strum (the
// uninstaller's «delete app data» removes it), so nothing is ever written into the install folder;
// the songs, takes, settings and own amps in the user's own folder, C:\Users\<name>\Strum (never
// touched by the uninstaller). Not Documents: on many computers Documents is synced to OneDrive,
// which would upload gigabytes of stems and lock files while the app writes them.
//
// For checks: STRUM_DATA_DIR and STRUM_LOCAL_DIR replace those two folders, STRUM_GUITAR_FAKE plays
// a fake input instead of the sound card (KV_GUITAR_FAKE of the engine).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

// WebView2 flags: the sound starts without a key press (the app's own start screen is for browsers).
// The rest are Tauri's defaults, which an own list replaces.
const BROWSER_ARGS: &str =
    "--autoplay-policy=no-user-gesture-required --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const SERVICE_START_TIMEOUT: Duration = Duration::from_secs(120);
const RESTARTS: u32 = 3;
// kv_service/components.py: the service ends with this code to be started again.
const RESTART_CODE: i32 = 75;

static CLOSING: AtomicBool = AtomicBool::new(false);
// The service's port once the window shows the app (0 before): the only place it may go then.
static APP_PORT: AtomicU16 = AtomicU16::new(0);

/// Where the window may go: the start screen until the app is there, then only the app. This also
/// keeps Alt+← and the mouse's back button (WebView2's own keys) from leaving the app for the start
/// screen, and any link from opening another site inside Strum's window.
fn may_navigate(url: &url::Url) -> bool {
    let port = APP_PORT.load(Ordering::SeqCst);
    let local = url.host_str() == Some("127.0.0.1") && url.port() == Some(port) && url.scheme() == "http";
    // Saved files (backing tracks, lyrics) are blob: links of the app's own page.
    let own_blob = url.scheme() == "blob" && url.path().starts_with(&format!("http://127.0.0.1:{port}/"));
    if port != 0 {
        return local || own_blob;
    }
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
}

#[derive(Clone)]
struct Paths {
    uv: PathBuf,
    project: PathBuf,
    web: PathBuf,
    local: PathBuf,
    env: PathBuf,
    logs: PathBuf,
    docs: PathBuf,
}

impl Paths {
    fn python(&self) -> PathBuf {
        if cfg!(windows) {
            self.env.join("Scripts").join("python.exe")
        } else {
            self.env.join("bin").join("python3")
        }
    }
}

fn paths(app: &AppHandle) -> Result<Paths, String> {
    let res = app.path().resource_dir().map_err(|e| e.to_string())?;
    let local = match std::env::var_os("STRUM_LOCAL_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => app.path().app_local_data_dir().map_err(|e| e.to_string())?,
    };
    let docs = match std::env::var_os("STRUM_DATA_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => app.path().home_dir().map_err(|e| e.to_string())?.join("Strum"),
    };
    let uv = res.join(if cfg!(windows) { "uv.exe" } else { "uv" });
    Ok(Paths {
        uv,
        project: res.join("app"),
        web: res.join("web"),
        env: local.join("env"),
        logs: local.join("logs"),
        local,
        docs,
    })
}

// ---------------------------------------------------------------------------------------------
// The start screen

fn js_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

fn show(window: &WebviewWindow, state: &str, detail: &str) {
    let script = format!(
        "window.strum && window.strum.show({}, {})",
        js_string(state),
        js_string(detail)
    );
    let _ = window.eval(&script);
}

/// The language saved in the app's settings (<home>\Strum\settings.json), for the start screen.
fn saved_language(docs: &Path) -> String {
    let text = fs::read_to_string(docs.join("settings.json")).unwrap_or_default();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    // Empty on a first start: the start screen then takes the system's language, when it has it.
    value["state"]["language"].as_str().unwrap_or("").to_string()
}

// ---------------------------------------------------------------------------------------------
// Logs

fn log_file(logs: &Path, name: &str) -> Option<File> {
    fs::create_dir_all(logs).ok()?;
    OpenOptions::new().create(true).append(true).open(logs.join(name)).ok()
}

fn log_line(logs: &Path, line: &str) {
    if let Some(mut file) = log_file(logs, "strum.log") {
        let _ = writeln!(file, "{line}");
    }
}

// ---------------------------------------------------------------------------------------------
// Child processes: no console windows, and all of them in one job that dies with this process.

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);
    // The handle is only used to add processes; Windows closes it when this process ends.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Option<Job> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return None;
                }
                Some(Job(handle))
            }
        }

        pub fn add(&self, child: &std::process::Child) {
            unsafe {
                AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE);
            }
        }
    }
}

#[cfg(not(windows))]
mod job {
    pub struct Job;
    impl Job {
        pub fn new() -> Option<Job> {
            Some(Job)
        }
        pub fn add(&self, _child: &std::process::Child) {}
    }
}

fn no_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// What uv and the Python processes need: where Python, the packages and the cache live, and
/// nothing of the person's own Python setup.
fn base_env(command: &mut Command, p: &Paths) {
    command
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .env_remove("VIRTUAL_ENV")
        .env("UV_PROJECT_ENVIRONMENT", &p.env)
        .env("UV_PYTHON_INSTALL_DIR", p.local.join("python"))
        .env("UV_CACHE_DIR", p.local.join("cache"))
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        .env("UV_NO_CONFIG", "1")
        .env("PYTHONUTF8", "1")
        .env("PYTHONUNBUFFERED", "1")
        // Compiled code beside the environment, not in the program's folder (the uninstaller
        // removes what it installed and would leave those behind).
        .env("PYTHONPYCACHEPREFIX", p.local.join("pycache"))
        // Numba keeps the guitar engine's compiled kernels in a cache of its own, which the line
        // above does not move: without this it is __pycache__ beside kv_guitar's source.
        .env("NUMBA_CACHE_DIR", p.local.join("numba"));
}

// ---------------------------------------------------------------------------------------------
// Step 2: Python and the base packages

fn lock_hash(project: &Path) -> String {
    // FNV-1a of uv.lock: a new version of the packages means a new sync.
    let bytes = fs::read(project.join("uv.lock")).unwrap_or_default();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn ensure_runtime(p: &Paths, window: &WebviewWindow) -> Result<(), String> {
    let stamp_path = p.env.join(".strum-stamp");
    // The program's folder too: the environment points at its code there, so a program installed
    // somewhere else (or moved) syncs again (quick: everything is in the cache).
    let want = format!("{VERSION}\n{}\n{}", lock_hash(&p.project), p.project.display());
    if p.python().is_file() && fs::read_to_string(&stamp_path).ok().as_deref() == Some(want.as_str()) {
        return Ok(());
    }
    show(window, "setup", "");
    let mut command = Command::new(&p.uv);
    // --inexact: the neural networks the app added later stay (a plain sync would remove them).
    command
        .args(["sync", "--frozen", "--no-dev", "--inexact", "--project"])
        .arg(&p.project)
        .current_dir(&p.local)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    base_env(&mut command, p);
    no_window(&mut command);
    let mut child = command.spawn().map_err(|e| format!("uv: {e}"))?;
    let mut log = log_file(&p.logs, "setup.log");
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let readers: Vec<_> = [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .map(|stream| {
        let lines = lines.clone();
        let window = window.clone();
        thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                show(&window, "setup", &line);
                lines.lock().unwrap().push(line);
            }
        })
    })
    .collect();
    let status = child.wait().map_err(|e| e.to_string())?;
    for reader in readers {
        let _ = reader.join();
    }
    let lines = lines.lock().unwrap();
    if let Some(log) = log.as_mut() {
        for line in lines.iter() {
            let _ = writeln!(log, "{line}");
        }
    }
    if !status.success() {
        let last = lines.iter().rev().take(3).cloned().collect::<Vec<_>>().join(" · ");
        return Err(format!("setup:{last}"));
    }
    fs::write(&stamp_path, want).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Step 3: the service and the engine

/// The same ports every time when they are free: the page keeps one address, so WebView2 keeps its
/// microphone permission (the browser path) between starts. Any free port otherwise.
const PREFERRED_PORTS: (u16, u16) = (47823, 47824);

fn free_port(preferred: u16) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", preferred))
        .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
        .map_err(|e| e.to_string())?;
    listener.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

/// Our service answers /api/runtime with our instance word (a program that took the port first does not
/// know it, so the window never shows its page).
fn answers(port: u16, instance: &str) -> bool {
    let address = ([127, 0, 0, 1], port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET /api/runtime HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut reply = Vec::new();
    let _ = stream.take(64 * 1024).read_to_end(&mut reply);
    let reply = String::from_utf8_lossy(&reply);
    reply.starts_with("HTTP/1.1 200") && reply.contains(&format!("\"instance\":\"{instance}\""))
}

/// A word nobody else knows: time, process id and the standard library's random hash keys.
fn instance_word() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut word = String::new();
    for salt in 0..2u64 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(salt);
        hasher.write_u32(std::process::id());
        hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        word.push_str(&format!("{:016x}", hasher.finish()));
    }
    word
}

struct Ports {
    service: u16,
    guitar: u16,
    instance: String,
}

fn python_process(p: &Paths, ports: &Ports, module: &str, log_name: &str) -> Result<Child, String> {
    let log = log_file(&p.logs, log_name).ok_or("log")?;
    let log2 = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = Command::new(p.python());
    command
        .args(["-m", module])
        .current_dir(&p.local)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log2);
    base_env(&mut command, p);
    no_window(&mut command);
    let library = p.docs.join("Library");
    command
        .env("KV_PORT", ports.service.to_string())
        .env("KV_GUITAR_PORT", ports.guitar.to_string())
        .env("KV_LIBRARY_DIR", &library)
        .env("KV_USER_DIR", &p.docs)
        .env("KV_MODELS_DIR", p.local.join("models"))
        .env("KV_WEB_DIR", &p.web)
        .env("KV_TONES_DIR", p.web.join("tones"))
        .env("KV_SHELL", "1")
        .env("KV_INSTANCE", &ports.instance)
        // The engine takes only this page (another local program's page on another port is refused).
        .env("KV_PAGE_ORIGINS", format!("http://127.0.0.1:{}", ports.service))
        .env("KV_UV", &p.uv)
        .env("KV_PROJECT_DIR", &p.project)
        // PortAudio lists ASIO devices only with this set before sounddevice loads.
        .env("SD_ENABLE_ASIO", "1");
    if let Some(fake) = std::env::var_os("STRUM_GUITAR_FAKE") {
        command.env("KV_GUITAR_FAKE", fake);
    }
    command.spawn().map_err(|e| format!("{module}: {e}"))
}

/// Starts a process and starts it again if it ends while the window is open (a few times).
fn supervise(p: Paths, ports: Arc<Ports>, job: Arc<job::Job>, module: &'static str, log_name: &'static str) -> Result<(), String> {
    let mut child = python_process(&p, &ports, module, log_name)?;
    job.add(&child);
    thread::spawn(move || {
        let mut restarts = 0;
        loop {
            let status = child.wait();
            if CLOSING.load(Ordering::SeqCst) {
                return;
            }
            log_line(&p.logs, &format!("{module} ended ({status:?})"));
            // The service asks for a restart after it downloaded the neural networks: not a failure.
            let asked = matches!(&status, Ok(s) if s.code() == Some(RESTART_CODE));
            if !asked {
                if restarts >= RESTARTS {
                    return;
                }
                restarts += 1;
                thread::sleep(Duration::from_secs(2));
            }
            match python_process(&p, &ports, module, log_name) {
                Ok(next) => {
                    job.add(&next);
                    child = next;
                }
                Err(error) => {
                    log_line(&p.logs, &format!("{module} did not restart: {error}"));
                    return;
                }
            }
        }
    });
    Ok(())
}

fn boot(app: AppHandle, window: WebviewWindow, job: Arc<job::Job>) -> Result<(), String> {
    let p = paths(&app)?;
    for dir in [&p.local, &p.logs, &p.docs] {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    log_line(&p.logs, &format!("Strum {VERSION} starting"));
    if !p.uv.is_file() || !p.web.join("index.html").is_file() {
        return Err("files".into());
    }
    ensure_runtime(&p, &window)?;
    show(&window, "starting", "");
    let ports = Arc::new(Ports {
        service: free_port(PREFERRED_PORTS.0)?,
        guitar: free_port(PREFERRED_PORTS.1)?,
        instance: instance_word(),
    });
    supervise(p.clone(), ports.clone(), job.clone(), "kv_service", "service.log")?;
    // The engine is not needed for the page to open: if it fails, the guitar plays through WebView2.
    if let Err(error) = supervise(p.clone(), ports.clone(), job, "kv_guitar", "guitar.log") {
        log_line(&p.logs, &format!("guitar engine: {error}"));
    }
    let started = Instant::now();
    while !answers(ports.service, &ports.instance) {
        if started.elapsed() > SERVICE_START_TIMEOUT {
            return Err("service".into());
        }
        thread::sleep(Duration::from_millis(150));
    }
    let url = url::Url::parse(&format!("http://127.0.0.1:{}/", ports.service)).map_err(|e| e.to_string())?;
    log_line(&p.logs, &format!("open {url}"));
    APP_PORT.store(ports.service, Ordering::SeqCst);
    window.navigate(url).map_err(|e| e.to_string())
}

fn main() {
    let job = Arc::new(job::Job::new().expect("job object"));
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            let handle = app.handle().clone();
            let docs = paths(&handle).map(|p| p.docs).unwrap_or_default();
            let lang = saved_language(&docs);
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                // The start screen's language (it runs before the app and its settings are there).
                .initialization_script(&format!("window.__strumLang = {};", js_string(&lang)))
                .title("Strum")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .maximized(true)
                .additional_browser_args(BROWSER_ARGS)
                // The app takes dropped songs, tabs and amp files itself (HTML drag and drop); Tauri's
                // own handler would swallow them.
                .disable_drag_drop_handler()
                .on_navigation(may_navigate)
                .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            let job = job.clone();
            thread::spawn(move || {
                // Let the start screen load before it is told anything.
                thread::sleep(Duration::from_millis(300));
                if let Err(error) = boot(handle.clone(), window.clone(), job) {
                    if let Ok(p) = paths(&handle) {
                        log_line(&p.logs, &format!("start failed: {error}"));
                        show(&window, "error", &format!("{error}\n{}", p.logs.display()));
                    } else {
                        show(&window, "error", &error);
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Half a second for the page to send what it has not saved yet (settings go 0.3 s after
            // a change), then the window closes and the job takes the service and the engine along.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !CLOSING.swap(true, Ordering::SeqCst) {
                    api.prevent_close();
                    let window = window.clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(500));
                        let _ = window.destroy();
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Strum could not start");
}
