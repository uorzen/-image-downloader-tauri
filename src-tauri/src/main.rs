#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 图片下载器 · Tauri 桌面端
//! 架构：系统 WebView（前端 HTML/CSS/JS）  <--invoke/event-->  Rust 核心二进制（本文件）
//!
//! 职责边界：前端管「组织和展示」，Rust 管「文件、表格、下载」。
//! 功能对齐原 tkinter 脚本：TXT 任务列表、表格匹配（模糊容差）、
//! 按名建子文件夹、{匹配名}-{序号}{ext} 改名、并发/重试/停止、
//! 跳过已存在、失败日志、系统托盘、开机启动。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt;

/* ============================================================
   托管状态
   ============================================================ */

/// 保持文件监控器存活
struct WatchState(Mutex<Vec<notify::RecommendedWatcher>>);

/// 下载停止标记（前端「停止」按钮置位，下载任务轮询）
struct StopFlag(Arc<AtomicBool>);

/// 已加载的匹配表格（load_table 写入，preview_match / 下载时读取）
struct TableState(Mutex<Option<TableData>>);

struct TableData {
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
}

/* ============================================================
   事件 / 序列化载荷
   ============================================================ */

/// 下载进度：每完成一项推一次，结束时推 status = done | stopped
#[derive(Serialize, Clone)]
struct Progress {
    done: usize,
    total: usize,
    ok: usize,
    fail: usize,
    status: String,
    url: String,
}

#[derive(Serialize, Clone)]
struct FsEvent {
    path: String,
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TableInfo {
    columns: Vec<String>,
    rows: usize,
}

#[derive(Serialize)]
struct MatchPreview {
    name: String,
    matched: Option<String>,
    ratio: f64,
}

#[derive(Deserialize)]
struct DownloadJob {
    urls: Vec<String>,
    /// 空串 = 粘贴模式（沿用 URL 文件名）；否则按 {name}-{序号}{ext} 命名
    name: String,
    /// 空串 = 不建子文件夹；否则在输出目录内建同名子文件夹
    subfolder: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadOptions {
    concurrency: u32,
    conflict: String,
    retry: u32,
}

/* ============================================================
   文件 / 对话框命令
   ============================================================ */

/// 选择文件夹（系统原生对话框）
#[tauri::command]
fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string_lossy().into_owned())
}

/// 多选 TXT 文件
#[tauri::command]
fn pick_txt_files(app: tauri::AppHandle) -> Option<Vec<String>> {
    app.dialog()
        .file()
        .add_filter("文本文件", &["txt"])
        .blocking_pick_files()
        .map(|fs| {
            fs.iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        })
}

/// 选择匹配表格（xlsx / xls / csv）
#[tauri::command]
fn pick_table_file(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter("表格文件", &["xlsx", "xls", "csv"])
        .blocking_pick_file()
        .map(|p| p.to_string_lossy().into_owned())
}

/// 用资源管理器打开目录（Windows）
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 列出目录下的文件名，按名称排序
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

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/* ============================================================
   表格匹配：calamine 读 xlsx/xls，csv 手工解析，difflib 模糊匹配
   ============================================================ */

fn cell_to_string(cell: &calamine::Data) -> String {
    match cell {
        calamine::Data::Empty => String::new(),
        other => other.to_string(),
    }
}

/// 极简 CSV 行解析（双引号转义）
fn parse_csv_line(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if in_q {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    cur.push('"');
                    chars.next();
                } else {
                    in_q = false;
                }
            } else {
                cur.push(c);
            }
        } else if c == '"' {
            in_q = true;
        } else if c == ',' {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
    }
    out.push(cur);
    out
}

fn read_table(path: &str) -> Result<(Vec<String>, Vec<Vec<String>>), String> {
    let ext = std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let mut all: Vec<Vec<String>> = Vec::new();
    if ext == "csv" {
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let text = text.trim_start_matches('\u{feff}');
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            all.push(parse_csv_line(line));
        }
    } else if ext == "xls" {
        let mut wb: calamine::Xls<_> =
            calamine::open_workbook(path).map_err(|e| e.to_string())?;
        let range = wb
            .worksheet_range_at(0)
            .ok_or("表格为空")?
            .map_err(|e| e.to_string())?;
        for r in range.rows() {
            all.push(r.iter().map(cell_to_string).collect());
        }
    } else {
        let mut wb: calamine::Xlsx<_> =
            calamine::open_workbook(path).map_err(|e| e.to_string())?;
        let range = wb
            .worksheet_range_at(0)
            .ok_or("表格为空")?
            .map_err(|e| e.to_string())?;
        for r in range.rows() {
            all.push(r.iter().map(cell_to_string).collect());
        }
    }

    if all.is_empty() {
        return Err("表格为空".into());
    }
    let columns = all
        .remove(0)
        .into_iter()
        .map(|c| c.trim().to_string())
        .collect();
    Ok((columns, all))
}

/// 加载表格，返回列名与行数（表格内容留在 Rust 侧供后续匹配）
#[tauri::command]
fn load_table(path: String, state: tauri::State<TableState>) -> Result<TableInfo, String> {
    let (columns, rows) = read_table(&path)?;
    let info = TableInfo {
        columns: columns.clone(),
        rows: rows.len(),
    };
    *state.0.lock().unwrap() = Some(TableData { columns, rows });
    Ok(info)
}

/// 复刻原脚本 clean_and_remove_special：去掉括号片段与非法字符并转小写
fn clean_name(name: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for ch in name.chars() {
        if depth == 0 {
            if matches!(ch, '【' | '（' | '(') {
                depth += 1;
            } else {
                out.push(ch);
            }
        } else if matches!(ch, '】' | '）' | ')') {
            depth -= 1;
        }
    }
    out.chars()
        .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect::<String>()
        .to_lowercase()
}

fn strip_ext(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) => &name[..i],
        None => name,
    }
}

/* ---------- difflib.SequenceMatcher.ratio 的 Rust 复刻 ---------- */

fn find_longest_match(
    a: &[char],
    b: &[char],
    b2j: &HashMap<char, Vec<usize>>,
    alo: usize,
    ahi: usize,
    blo: usize,
    bhi: usize,
) -> (usize, usize, usize) {
    let (mut besti, mut bestj, mut bestsize) = (alo, blo, 0usize);
    let mut j2len: HashMap<usize, usize> = HashMap::new();
    for i in alo..ahi {
        let mut newj2len: HashMap<usize, usize> = HashMap::new();
        if let Some(js) = b2j.get(&a[i]) {
            for &j in js {
                if j < blo {
                    continue;
                }
                if j >= bhi {
                    break;
                }
                let k = j
                    .checked_sub(1)
                    .and_then(|p| j2len.get(&p))
                    .copied()
                    .unwrap_or(0)
                    + 1;
                newj2len.insert(j, k);
                if k > bestsize {
                    besti = i + 1 - k;
                    bestj = j + 1 - k;
                    bestsize = k;
                }
            }
        }
        j2len = newj2len;
    }
    (besti, bestj, bestsize)
}

fn total_matched(a: &[char], b: &[char], b2j: &HashMap<char, Vec<usize>>) -> usize {
    fn rec(
        a: &[char],
        b: &[char],
        b2j: &HashMap<char, Vec<usize>>,
        alo: usize,
        ahi: usize,
        blo: usize,
        bhi: usize,
        acc: &mut usize,
    ) {
        if alo >= ahi || blo >= bhi {
            return;
        }
        let (i, j, k) = find_longest_match(a, b, b2j, alo, ahi, blo, bhi);
        if k == 0 {
            return;
        }
        if alo < i && blo < j {
            rec(a, b, b2j, alo, i, blo, j, acc);
        }
        *acc += k;
        if i + k < ahi && j + k < bhi {
            rec(a, b, b2j, i + k, ahi, j + k, bhi, acc);
        }
    }
    let mut acc = 0usize;
    rec(a, b, b2j, 0, a.len(), 0, b.len(), &mut acc);
    acc
}

fn sequence_ratio(a: &[char], b: &[char]) -> f64 {
    let total = a.len() + b.len();
    if total == 0 {
        return 1.0;
    }
    let mut b2j: HashMap<char, Vec<usize>> = HashMap::new();
    for (j, &ch) in b.iter().enumerate() {
        b2j.entry(ch).or_default().push(j);
    }
    2.0 * total_matched(a, b, &b2j) as f64 / total as f64
}

/// 预览匹配：names 为 TXT 文件名列表（含扩展名），返回每个的最佳匹配行
#[tauri::command]
fn preview_match(
    names: Vec<String>,
    match_col: String,
    rename_col: String,
    tolerance: f64,
    state: tauri::State<TableState>,
) -> Result<Vec<MatchPreview>, String> {
    let guard = state.0.lock().unwrap();
    let data = guard.as_ref().ok_or("尚未加载表格")?;
    let mi = data
        .columns
        .iter()
        .position(|c| *c == match_col)
        .ok_or("匹配列不存在")?;
    let ri = data
        .columns
        .iter()
        .position(|c| *c == rename_col)
        .ok_or("重命名列不存在")?;

    // 目标列：清理后的字符数组 + 原始重命名值
    let targets: Vec<(Vec<char>, String)> = data
        .rows
        .iter()
        .map(|r| {
            let raw = r.get(mi).cloned().unwrap_or_default();
            (clean_name(&raw).chars().collect::<Vec<char>>(), raw)
        })
        .collect();

    Ok(names
        .iter()
        .map(|n| {
            let cleaned = clean_name(strip_ext(n)).chars().collect::<Vec<char>>();
            let mut best_ratio = 0.0f64;
            let mut best_rename: Option<String> = None;
            for (tchars, raw) in &targets {
                let ratio = sequence_ratio(&cleaned, tchars);
                let max_len = cleaned.len().max(tchars.len());
                let allowed = if max_len > 0 { tolerance / max_len as f64 } else { 0.0 };
                if ratio >= 1.0 - allowed && ratio > best_ratio {
                    best_ratio = ratio;
                    best_rename = Some(raw.clone());
                }
            }
            MatchPreview {
                name: n.clone(),
                matched: best_rename,
                ratio: best_ratio,
            }
        })
        .collect())
}

/* ============================================================
   下载核心：并发 / 重试 / 停止 / 重名冲突 / 失败日志
   ============================================================ */

/// 从 URL 推断扩展名（jpg/jpeg/png/gif 之外的统一回退 .jpg，对齐原脚本）
fn ext_of_url(url: &str) -> String {
    let path = url.split('?').next().unwrap_or(url);
    let seg = path.rsplit('/').next().unwrap_or("");
    let ext = format!(
        ".{}",
        seg.rsplit('.').next().unwrap_or("").to_lowercase()
    );
    if matches!(ext.as_str(), ".jpg" | ".jpeg" | ".png" | ".gif") {
        ext
    } else {
        ".jpg".into()
    }
}

/// 从 URL 推导安全文件名（粘贴模式用）
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

/// 重名冲突三策略。返回 None 表示「跳过已存在」
fn resolve_dest(dir: &std::path::Path, filename: &str, conflict: &str) -> Option<std::path::PathBuf> {
    let p = dir.join(filename);
    if !p.exists() {
        return Some(p);
    }
    match conflict {
        "overwrite" => Some(p),
        "skip" => None,
        _ => {
            // 自动改名 a.jpg -> a-1.jpg -> a-2.jpg ...
            let (stem, ext) = match filename.rfind('.') {
                Some(i) => (&filename[..i], &filename[i..]),
                None => (filename, ""),
            };
            for n in 1..1000u32 {
                let cand = dir.join(format!("{}-{}{}", stem, n, ext));
                if !cand.exists() {
                    return Some(cand);
                }
            }
            None
        }
    }
}

/// 批量下载。jobs 由前端按 TXT/粘贴模式组装，逐项推 progress 事件
#[tauri::command]
async fn download_batch(
    jobs: Vec<DownloadJob>,
    dest_dir: String,
    options: DownloadOptions,
    app: tauri::AppHandle,
    stop: tauri::State<'_, StopFlag>,
) -> Result<Progress, String> {
    let dest = std::path::Path::new(&dest_dir).to_path_buf();
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    stop.0.store(false, Ordering::SeqCst);

    // 预解析目标路径：重名冲突与跳过已存在在此敲定
    let mut items: Vec<(String, std::path::PathBuf)> = Vec::new();
    let mut skipped = 0usize;
    'outer: for job in &jobs {
        let dir = if job.subfolder.is_empty() {
            dest.clone()
        } else {
            dest.join(&job.subfolder)
        };
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }
        for (idx, raw) in job.urls.iter().enumerate() {
            if stop.0.load(Ordering::SeqCst) {
                break 'outer;
            }
            let url = raw.trim();
            if url.is_empty() {
                continue;
            }
            let filename = if job.name.is_empty() {
                sanitize_filename(url)
            } else {
                format!("{}-{}{}", job.name, idx + 1, ext_of_url(url))
            };
            match resolve_dest(&dir, &filename, &options.conflict) {
                Some(p) => items.push((url.to_string(), p)),
                None => skipped += 1,
            }
        }
    }

    let total = items.len() + skipped;
    let ok = Arc::new(AtomicUsize::new(skipped));
    let fail = Arc::new(AtomicUsize::new(0));
    let done = Arc::new(AtomicUsize::new(skipped));
    let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    if skipped > 0 {
        let _ = app.emit(
            "progress",
            Progress {
                done: skipped,
                total,
                ok: skipped,
                fail: 0,
                status: "item".into(),
                url: String::new(),
            },
        );
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    let sem = Arc::new(tokio::sync::Semaphore::new(options.concurrency.max(1) as usize));
    let retry = options.retry.min(5);

    let mut handles = Vec::new();
    for (url, dest_path) in items {
        let client = client.clone();
        let sem = sem.clone();
        let stop = stop.0.clone();
        let ok = ok.clone();
        let fail = fail.clone();
        let done = done.clone();
        let errors = errors.clone();
        let app = app.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire_owned().await;
            let mut attempt = 0u32;
            let mut success = false;
            while attempt <= retry {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                if let Ok(resp) = client.get(&url).send().await {
                    if resp.status().is_success() {
                        if let Ok(bytes) = resp.bytes().await {
                            if std::fs::write(&dest_path, &bytes).is_ok() {
                                success = true;
                                break;
                            }
                        }
                    }
                }
                attempt += 1;
                if attempt <= retry {
                    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                }
            }
            if success {
                ok.fetch_add(1, Ordering::SeqCst);
            } else {
                fail.fetch_add(1, Ordering::SeqCst);
                errors
                    .lock()
                    .unwrap()
                    .push(format!("{}\t{}", url, dest_path.display()));
            }
            let d = done.fetch_add(1, Ordering::SeqCst) + 1;
            let status = if !success && stop.load(Ordering::SeqCst) {
                "stopping"
            } else {
                "item"
            };
            let _ = app.emit(
                "progress",
                Progress {
                    done: d,
                    total,
                    ok: ok.load(Ordering::SeqCst),
                    fail: fail.load(Ordering::SeqCst),
                    status: status.into(),
                    url,
                },
            );
        }));
    }
    for h in handles {
        let _ = h.await;
    }

    let err_list = errors.lock().unwrap();
    if !err_list.is_empty() {
        let _ = std::fs::write(dest.join("download_errors.log"), err_list.join("\n"));
    }
    drop(err_list);

    let stopped = stop.0.load(Ordering::SeqCst);
    let final_status = if stopped { "stopped" } else { "done" };
    let _ = app.emit(
        "progress",
        Progress {
            done: done.load(Ordering::SeqCst),
            total,
            ok: ok.load(Ordering::SeqCst),
            fail: fail.load(Ordering::SeqCst),
            status: final_status.into(),
            url: String::new(),
        },
    );
    Ok(Progress {
        done: done.load(Ordering::SeqCst),
        total,
        ok: ok.load(Ordering::SeqCst),
        fail: fail.load(Ordering::SeqCst),
        status: final_status.into(),
        url: String::new(),
    })
}

/// 停止下载：置位标记，进行中的任务会在下一个轮询点退出
#[tauri::command]
fn stop_download(state: tauri::State<StopFlag>) {
    state.0.store(true, Ordering::SeqCst);
}

/* ============================================================
   开机启动（tauri-plugin-autostart）
   ============================================================ */

#[tauri::command]
fn autostart_status(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_toggle(app: tauri::AppHandle) -> Result<bool, String> {
    let al = app.autolaunch();
    if al.is_enabled().map_err(|e| e.to_string())? {
        al.disable().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        al.enable().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

/* ============================================================
   实时监控（watchdog 等价）：新 .txt 事件由前端过滤并入列
   ============================================================ */

#[tauri::command]
fn start_watch(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
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

    app.state::<WatchState>().0.lock().unwrap().push(watcher);
    Ok(())
}

/* ============================================================
   入口：窗口关闭收托盘 + 托盘菜单
   ============================================================ */

fn main() {
    tauri::Builder::default()
        // 单实例必须最先注册：再次启动时新进程立即退出，回调在老进程里执行
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            // 通知前端弹提示
            let _ = app.emit("second-instance", ());
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(WatchState(Mutex::new(Vec::new())))
        .manage(StopFlag(Arc::new(AtomicBool::new(false))))
        .manage(TableState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            pick_directory,
            pick_txt_files,
            pick_table_file,
            open_path,
            list_directory,
            read_text,
            write_text,
            load_table,
            preview_match,
            download_batch,
            stop_download,
            autostart_status,
            autostart_toggle,
            start_watch
        ])
        // 关窗不退出：隐藏到托盘，退出走托盘菜单
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("图片下载器")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
