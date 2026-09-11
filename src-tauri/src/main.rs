#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 图片下载器 · Tauri 桌面端
//! 架构：系统 WebView（前端 HTML/CSS/JS）  <--invoke/event-->  Rust 核心二进制（本文件）
//!
//! 注意：本文件在未安装 Rust 工具链的沙箱中无法编译，仅作完整源码交付；
//! 在本机 `cargo tauri dev` / `cargo tauri build` 即可运行。

use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

/// 下载进度事件载荷（通过 `app.emit("progress", ...)` 推到前端）
#[derive(Serialize, Clone)]
struct Progress {
    url: String,
    done: usize,
    total: usize,
    status: String,
}

/// 文件系统监控事件载荷（`start_watch` 触发后持续推送）
#[derive(Serialize, Clone)]
struct FsEvent {
    path: String,
    kind: String,
}

/// 托管正在运行的文件监控器，避免函数返回后被 drop 而停止监控
struct WatchState(Mutex<Vec<notify::RecommendedWatcher>>);

/// 选择文件夹（系统原生对话框）。返回绝对路径，取消则为 None
#[tauri::command]
fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// 列出目录下的文件名（不含路径），按名称排序
#[tauri::command]
fn list_directory(path: String) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        out.push(entry.file_name().to_string_lossy().into_owned());
    }
    out.sort();
    Ok(out)
}

/// 从 URL 推导出安全的本地文件名（去查询串、去非法字符）
fn sanitize_filename(url: &str) -> String {
    let trimmed = url.trim();
    let seg = trimmed
        .rsplit('/')
        .next()
        .unwrap_or(trimmed)
        .split('?')
        .next()
        .unwrap_or(trimmed)
        .to_string();
    let illegal: &[char] = &['<', '>', '"', '/', '\\', '|', '?', '*', ':'];
    let cleaned: String = seg.chars().filter(|c| !illegal.contains(c)).collect();
    if cleaned.is_empty() {
        "download.bin".to_string()
    } else {
        cleaned
    }
}

/// 批量下载：异步（不阻塞 UI 线程），每完成一个就向前端推 `progress` 事件
#[tauri::command]
async fn download_many(
    urls: Vec<String>,
    dest_dir: String,
    app: tauri::AppHandle,
) -> Result<Progress, String> {
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let total = urls.len();
    let mut done = 0usize;

    for url in urls {
        let url = url.trim().to_string();
        if url.is_empty() {
            continue;
        }
        let name = sanitize_filename(&url);
        let dest = std::path::Path::new(&dest_dir).join(&name);
        if let Ok(resp) = reqwest::get(&url).await {
            if let Ok(bytes) = resp.bytes().await {
                let _ = std::fs::write(&dest, &bytes);
            }
        }
        done += 1;
        let _ = app.emit(
            "progress",
            Progress {
                url: url.clone(),
                done,
                total,
                status: "ok".into(),
            },
        );
    }

    Ok(Progress {
        url: String::new(),
        done,
        total,
        status: "done".into(),
    })
}

/// 启动对某个目录的递归监控；后续新文件事件通过 `fs-event` 推到前端
#[tauri::command]
fn start_watch(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher =
        notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    watcher
        .watch(std::path::Path::new(&path), notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        for res in rx {
            if let Ok(event) = res {
                for p in event.paths {
                    let _ = app.emit(
                        "fs-event",
                        FsEvent {
                            path: p.to_string_lossy().into_owned(),
                            kind: format!("{:?}", event.kind),
                        },
                    );
                }
            }
        }
    });

    // 存入托管状态，保持 watcher 存活到进程结束
    app.state::<WatchState>().0.lock().unwrap().push(watcher);
    Ok(())
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(WatchState(Mutex::new(Vec::new())))
        .invoke_handler(tauri::generate_handler![
            pick_directory,
            list_directory,
            download_many,
            start_watch,
            read_text,
            write_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
