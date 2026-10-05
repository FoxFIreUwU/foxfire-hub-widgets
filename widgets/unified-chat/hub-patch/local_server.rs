//! local_server.rs — локальный HTTP-сервер FoxFire Hub (только 127.0.0.1).
//!
//! Зачем: ссылки вида asset.localhost / file:// в OBS и браузере не работают или ломаются
//! (пустое окно, ERR_CONNECTION_REFUSED). Hub раздаёт папки установленных виджетов по
//! обычному адресу, который OBS и браузер открывают без проблем и который НЕ меняется
//! при правке настроек:
//!
//!     http://127.0.0.1:47821/w/unified-chat/index.html
//!
//! Маршруты:
//!   GET /ping                        → {"app":"foxfire-hub","port":N}   (для поиска порта из настроек)
//!   GET /w/<id-виджета>/<файл>       → файл из <widgets_dir>/<id>/<файл> (по умолчанию index.html)
//!   GET /api/yt/poll?channel=&video=&since=  → новые сообщения YouTube (см. youtube_chat.rs)
//!
//! Безопасность (сервер слушает только loopback, но открытые сайты в браузере тоже могут
//! обращаться на 127.0.0.1, поэтому):
//!   * проверяется заголовок Host (защита от DNS-rebinding) — только 127.0.0.1/localhost:порт;
//!   * запросы с Sec-Fetch-Site: cross-site (то есть с чужого сайта) отклоняются, кроме /ping;
//!   * выход за пределы папки виджетов (../) невозможен.
//!
//! Зависимости (Cargo.toml): tiny_http = "0.12".

use std::fs;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tiny_http::{Header, Method, Request, Response, Server};

const FIRST_PORT: u16 = 47821;
const LAST_PORT: u16 = 47830;

static PORT: OnceLock<u16> = OnceLock::new();
// id виджета -> папка установки. Регистрирует интерфейс Hub (команда register_widget_dir),
// поэтому работает и со стандартной папкой, и с папкой установки, выбранной пользователем.
static WIDGET_DIRS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

fn dirs() -> &'static Mutex<HashMap<String, PathBuf>> {
    WIDGET_DIRS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Tauri-команда: сообщить серверу, где лежит виджет `id`.
#[tauri::command]
pub fn register_widget_dir(id: String, dir: String) {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return;
    }
    dirs().lock().unwrap_or_else(|e| e.into_inner()).insert(id, PathBuf::from(dir));
}

/// Tauri-команда: какой порт занял сервер (или null, если не запустился).
#[tauri::command]
pub fn local_server_port() -> Option<u16> {
    PORT.get().copied()
}

/// Запускает сервер в фоне. `widgets_dir` — папка, где лежат папки установленных виджетов
/// (внутри — `unified-chat/index.html`, `unified-chat/config.js` и т.д.).
/// Возвращает занятый порт. Вызывать один раз при старте Hub.
pub fn start() -> Option<u16> {
    let (server, port) = (FIRST_PORT..=LAST_PORT).find_map(|p| {
        Server::http(("127.0.0.1", p)).ok().map(|s| (s, p))
    })?;
    let _ = PORT.set(port);
    let server = Arc::new(server);

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            // по потоку на запрос — чтобы один медленный клиент не стопорил остальные
            std::thread::spawn(move || handle(port, request));
        }
    });
    Some(port)
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn get_header(req: &Request, name: &str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn respond_text(req: Request, code: i16, body: &str) {
    let resp = Response::from_string(body.to_string())
        .with_status_code(code)
        .with_header(header("Content-Type", "text/plain; charset=utf-8"))
        .with_header(header("Cache-Control", "no-store"));
    let _ = req.respond(resp);
}

fn handle(port: u16, req: Request) {
    if *req.method() != Method::Get {
        return respond_text(req, 405, "method not allowed");
    }

    // Защита от DNS-rebinding: Host должен быть нашим loopback-адресом.
    let host_ok = get_header(&req, "Host")
        .map(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"))
        .unwrap_or(false);
    if !host_ok {
        return respond_text(req, 403, "bad host");
    }

    let url = req.url().to_string();
    let (path, query) = match url.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (url.clone(), String::new()),
    };

    if path == "/ping" {
        let body = format!("{{\"app\":\"foxfire-hub\",\"port\":{port}}}");
        let resp = Response::from_string(body)
            .with_header(header("Content-Type", "application/json"))
            .with_header(header("Access-Control-Allow-Origin", "*"))
            .with_header(header("Cache-Control", "no-store"));
        let _ = req.respond(resp);
        return;
    }

    // Всё остальное — только со своих страниц (не с чужих сайтов).
    if get_header(&req, "Sec-Fetch-Site").as_deref() == Some("cross-site") {
        return respond_text(req, 403, "cross-site requests are not allowed");
    }

    if path == "/api/yt/poll" {
        let channel = query_param(&query, "channel").unwrap_or_default();
        let video = query_param(&query, "video").unwrap_or_default();
        let since = query_param(&query, "since").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let result = crate::youtube_chat::poll(&channel, &video, since);
        let body = serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string());
        let resp = Response::from_string(body)
            .with_header(header("Content-Type", "application/json; charset=utf-8"))
            .with_header(header("Cache-Control", "no-store"));
        let _ = req.respond(resp);
        return;
    }

    if let Some(rest) = path.strip_prefix("/w/") {
        return serve_widget_file(rest, req);
    }

    respond_text(req, 404, "not found")
}

fn serve_widget_file(rest: &str, req: Request) {
    let decoded = percent_decode(rest);
    if decoded.contains('\\') || decoded.contains('\0') || decoded.split('/').any(|s| s == "..") {
        return respond_text(req, 400, "bad path");
    }
    let trimmed = decoded.trim_start_matches('/');
    // "<id>" | "<id>/" | "<id>/путь/к/файлу"
    let (id, file) = match trimmed.split_once('/') {
        Some((id, f)) => (id, f),
        None => (trimmed, ""),
    };
    let file = if file.is_empty() || file.ends_with('/') { format!("{file}index.html") } else { file.to_string() };

    let root = match dirs().lock().unwrap_or_else(|e| e.into_inner()).get(id) {
        Some(d) => d.clone(),
        None => return respond_text(req, 404, "widget is not registered (open FoxFire Hub first)"),
    };

    let candidate = root.join(&file);
    let (Ok(real_root), Ok(real_file)) = (fs::canonicalize(&root), fs::canonicalize(&candidate)) else {
        return respond_text(req, 404, "not found");
    };
    if !real_file.starts_with(&real_root) || !real_file.is_file() {
        return respond_text(req, 404, "not found");
    }
    match fs::read(&real_file) {
        Ok(bytes) => {
            let resp = Response::from_data(bytes)
                .with_header(header("Content-Type", mime_for(&real_file)))
                .with_header(header("Cache-Control", "no-store"));
            let _ = req.respond(resp);
        }
        Err(_) => respond_text(req, 404, "not found"),
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        Some("txt") | Some("md") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| percent_decode(&v.replace('+', " ")))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes() {
        assert_eq!(percent_decode("%40name"), "@name");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%D0%BF"), "п");
    }

    #[test]
    fn params() {
        assert_eq!(query_param("channel=%40me&since=5", "channel").as_deref(), Some("@me"));
        assert_eq!(query_param("channel=%40me&since=5", "since").as_deref(), Some("5"));
        assert_eq!(query_param("a=1", "b"), None);
    }
}
