// PROVision デスクトップ版。
//
// 画面はブラウザ版とまったく同じものを使い、画像生成とグラフの保存は
// 同梱した Node + Hono のサイドカーが担う。
//
// 構成は geo-logo（さらに元は Graphium）から移植した。踏み抜いた罠も引き継いでいる。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;

use tauri::{Emitter, Manager};

/// 起動したサイドカーの PID。二重起動を防ぐために保持する。
struct SidecarState(Mutex<Option<u32>>);

const DEFAULT_PORT: u16 = 8788;

/// 利用者が明示した保存先だけを持つ設定。app_data_dir/config.json に置く。
#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_root: Option<String>,
}

/// 画面に「いまどこに置いているか」を出すための現在値と既定値。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfo {
    current: String,
    default: String,
    /// 利用者が明示的に選んだ場所か
    custom: bool,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("設定の置き場を解決できません: {e}"))?;
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.join("config.json"))
}

fn read_config(app: &tauri::AppHandle) -> AppConfig {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 既定の保存先。**Documents の下**に置く。
///
/// Application Support に隠すと、利用者が中身（グラフの JSON-LD と画像）を
/// 見にいけない。この道具の成果物は「書き出したファイルそのもの」なので、
/// 手の届く場所に置く。Graphium と同じ方針。
fn default_workspace(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .document_dir()
        .map(|d| d.join("PROVision"))
        .unwrap_or_else(|_| {
            app.path()
                .app_data_dir()
                .expect("データディレクトリを解決できません")
                .join("run")
        })
}

fn workspace_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = match read_config(app).workspace_root {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => default_workspace(app),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("{} を作れません: {e}", dir.display()))?;
    Ok(dir)
}

#[tauri::command]
fn get_workspace_root(app: tauri::AppHandle) -> Result<WorkspaceInfo, String> {
    let default = default_workspace(&app);
    let current = workspace_dir(&app)?;
    Ok(WorkspaceInfo {
        custom: current != default,
        current: current.to_string_lossy().into_owned(),
        default: default.to_string_lossy().into_owned(),
    })
}

/// 保存先を変える。**中身は移さない**——移動は利用者の判断でやってもらう。
/// 黙って動かすと、どちらが本物か分からなくなる。
#[tauri::command]
fn set_workspace_root(app: tauri::AppHandle, path: Option<String>) -> Result<WorkspaceInfo, String> {
    let config = AppConfig {
        workspace_root: path.filter(|p| !p.trim().is_empty()),
    };
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(&app)?, json).map_err(|e| format!("設定を書けません: {e}"))?;
    get_workspace_root(app)
}

/// フォルダ選択ダイアログ。選ばれなければ None
#[tauri::command]
async fn pick_workspace_root(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // blocking_* は非同期コマンド（＝別スレッド）から呼ぶ。
    // メインスレッドで呼ぶと macOS で固まる
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked.map(|p| p.to_string()))
}

/// PID を殺す。プラットフォーム差を吸収する。
fn kill_pid(pid: u32) {
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    #[cfg(not(windows))]
    let _ = Command::new("kill")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// サイドカー（同梱 Node + バンドル済み Hono）を起動する。
///
/// Tauri Shell プラグインの sidecar 機能ではなく Rust から直接 spawn する。
/// Shell 経由だと Windows で spawn は成功するのに stdout/stderr が一切
/// 届かず、起動失敗の原因が追えなくなるため（Graphium で確認済み）。
#[tauri::command]
fn start_sidecar(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    port: Option<u16>,
) -> Result<u32, String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    let log = |line: String| {
        let _ = app.emit("sidecar-log", line);
    };

    // 前回の子プロセスが残っていたら先に始末する。孤児がポートを握ったままだと、
    // 自動更新のあとに新しい API が 404 になる
    {
        let mut guard = state.0.lock().unwrap();
        if let Some(old) = guard.take() {
            log(format!("[sidecar] 既存プロセス pid={old} を終了します"));
            kill_pid(old);
        }
    }

    let node_name = if cfg!(windows) { "sidecar/node.exe" } else { "sidecar/node" };
    let node = app
        .path()
        .resolve(node_name, tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("{node_name} を解決できません: {e}"))?;
    let script = app
        .path()
        .resolve("sidecar/server.mjs", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("sidecar/server.mjs を解決できません: {e}"))?;

    if !node.exists() {
        return Err(format!("Node が見つかりません: {}", node.display()));
    }
    if !script.exists() {
        return Err(format!("server.mjs が見つかりません: {}", script.display()));
    }

    // グラフと画像の置き場。.app 起動時の cwd は / なので、既定の cwd/data は作れない。
    // ここで場所を決めて必ず環境変数で渡す（geo-logo で踏んだ）
    let data_dir = workspace_dir(&app)?;
    log(format!("[sidecar] data: {}", data_dir.display()));

    // 設定は成果物と別の場所へ置く。Documents は TCC 保護対象で、**署名が変わると
    // 過去の許可が落ちる**——リリースのたびに署名は変わるので、更新直後に設定を
    // 読めない状態で起動しうる。そのとき「設定が無い」と区別できず、AI モデルの
    // 登録が消えたように見えていた。Application Support は TCC 保護外なので、
    // 利用者が直接開かない設定はこちらに置く（Graphium が同じ理由で移している）
    let config_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("設定の置き場を解決できません: {e}"))?;
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("{} を作れません: {e}", config_dir.display()))?;
    log(format!("[sidecar] config: {}", config_dir.display()));

    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .env("PROVISION_PORT", port.to_string())
        .env("PROVISION_DATA_DIR", &data_dir)
        .env("PROVISION_CONFIG_DIR", &config_dir)
        // 本体が消えたら自決させるための目印
        .env("PROVISION_PARENT_PID", std::process::id().to_string())
        .env("PROVISION_APP_VERSION", app.package_info().version.to_string())
        // APIキーは設定ファイルへ書かず、macOSではKeychainへ保存する。
        .env(
            "PROVISION_USE_KEYCHAIN",
            if cfg!(target_os = "macos") { "1" } else { "0" },
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        // 子プロセスのコンソールウィンドウを出さない（CREATE_NO_WINDOW）
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().map_err(|e| format!("起動に失敗しました: {e}"))?;
    let pid = child.id();
    log(format!("[sidecar] pid={pid} port={port} で起動しました"));

    for (stream, tag) in [
        (
            child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
            "stdout",
        ),
        (
            child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
            "stderr",
        ),
    ] {
        let Some(stream) = stream else { continue };
        let app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let _ = app.emit("sidecar-log", format!("[{tag}] {line}"));
            }
        });
    }

    {
        let app = app.clone();
        thread::spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
            let _ = app.emit("sidecar-closed", code);
        });
    }

    *state.0.lock().unwrap() = Some(pid);
    Ok(pid)
}

#[tauri::command]
fn stop_sidecar(state: tauri::State<'_, SidecarState>) -> Result<(), String> {
    if let Some(pid) = state.0.lock().unwrap().take() {
        kill_pid(pid);
    }
    Ok(())
}

/// グラフの置き場を OS のファイルマネージャで開く。
/// パスは Rust 側で決めるので、画面から任意のパスを開かせる口にはならない。
#[tauri::command]
fn open_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = workspace_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("フォルダを開けません: {e}"))
}

pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState(Mutex::new(None)));

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            start_sidecar,
            stop_sidecar,
            open_data_dir,
            get_workspace_root,
            set_workspace_root,
            pick_workspace_root
        ])
        .run(tauri::generate_context!())
        .expect("PROVision の起動に失敗しました");
}
