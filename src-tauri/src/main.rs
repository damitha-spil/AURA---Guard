#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct EngineChild(Mutex<Option<Child>>);

fn resolve_guard_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(parent) = manifest_dir.parent() {
        if parent.join("bin").join("aura-guard.mjs").exists() {
            return parent.to_path_buf();
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn extract_url(line: &str) -> Option<String> {
    let idx = line.find("http://127.0.0.1:")?;
    let rest = &line[idx..];
    let url = rest.split_whitespace().next()?.trim();
    if url.contains("?t=") {
        Some(url.to_string())
    } else {
        None
    }
}

fn main() {
    let root = resolve_guard_root();
    let entry = root.join("bin").join("aura-guard.mjs");

    let mut cmd = Command::new("node");
    cmd.arg(&entry)
        .arg("ui")
        .arg("--no-open")
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().expect("Failed to start SPIL REO Node engine");
    let stdout = child.stdout.take().expect("Missing engine stdout");

    let mut launch_url: Option<String> = None;
    let reader = BufReader::new(stdout);
    for line in reader.lines().map_while(Result::ok) {
        if let Some(u) = extract_url(&line) {
            launch_url = Some(u);
            break;
        }
    }

    let app = tauri::Builder::default()
        .manage(EngineChild(Mutex::new(Some(child))))
        .setup(move |app| {
            if let (Some(win), Some(url)) = (app.get_webview_window("main"), launch_url.clone()) {
                let parsed: tauri::Url = url.parse()?;
                win.navigate(parsed)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to build SPIL REO desktop app");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            if let Some(state) = app_handle.try_state::<EngineChild>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut c) = guard.take() {
                        let _ = c.kill();
                    }
                }
            }
        }
    });
}
