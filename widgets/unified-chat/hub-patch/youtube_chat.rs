//! youtube_chat.rs — чтение live-чата YouTube БЕЗ API-ключа (для FoxFire Hub, Tauri v1).
//!
//! Как это работает (тот же приём, что у pytchat / chat-downloader):
//!  1. Находим текущую трансляцию канала: GET youtube.com/@канал/live и смотрим,
//!     что вернулось (страница трансляции с "isLiveNow":true).
//!  2. Открываем страницу чата youtube.com/live_chat?is_popout=1&v=ID, достаём из неё
//!     ytInitialData, INNERTUBE_API_KEY (это публичный ключ самой страницы YouTube,
//!     не ключ пользователя) и первый "continuation".
//!  3. Раз в 1.5–8 секунд (интервал даёт сам YouTube) POST на
//!     /youtubei/v1/live_chat/get_live_chat — в ответе новые сообщения и следующий continuation.
//!
//! ВАЖНО: это НЕОФИЦИАЛЬНЫЙ интерфейс. YouTube может поменять формат — тогда правится
//! только этот файл. Ошибки показываются в виджете текстом (state = "error").
//!
//! Одна сессия на канал: её читают сразу все виджеты (окно Hub и OBS), YouTube опрашивается
//! один раз. Сессия сама останавливается, если за 45 секунд никто не спрашивал сообщения.
//!
//! Зависимости (Cargo.toml): reqwest (json, rustls-tls), serde (derive), serde_json, regex, tokio (time).

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// Без этих cookie в некоторых регионах (ЕС) YouTube отдаёт страницу согласия вместо чата.
const COOKIE: &str = "CONSENT=YES+1; SOCS=CAI";
const MAX_BUFFER: usize = 300;
const IDLE_STOP: Duration = Duration::from_secs(45);

#[derive(Clone, Serialize)]
pub struct Run {
    pub text: String,
    /// Для кастомных эмодзи канала — https-адрес картинки.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct ChatMsg {
    pub seq: u64,
    pub id: String,
    pub author: String,
    pub runs: Vec<Run>,
    /// owner | moderator | member | verified
    pub badges: Vec<String>,
    /// unix-время в миллисекундах
    pub ts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superchat: Option<String>,
}

#[derive(Serialize)]
pub struct PollResult {
    /// searching | connected | offline | error | idle
    pub state: String,
    pub message: String,
    /// Отдать это число обратно в следующий запрос как `since`.
    pub next: u64,
    pub messages: Vec<ChatMsg>,
}

struct Session {
    state: String,
    message: String,
    seq: u64,
    buf: VecDeque<ChatMsg>,
    last_seen: Instant,
    running: bool,
}

type Shared = Arc<Mutex<Session>>;

static SESSIONS: OnceLock<Mutex<HashMap<String, Shared>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, Shared>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock(s: &Shared) -> MutexGuard<'_, Session> {
    s.lock().unwrap_or_else(|e| e.into_inner())
}

fn set_state(s: &Shared, state: &str, message: &str) {
    let mut g = lock(s);
    g.state = state.to_string();
    g.message = message.to_string();
}

fn is_idle(s: &Shared) -> bool {
    lock(s).last_seen.elapsed() > IDLE_STOP
}

// ---------------------------------------------------------------------------
// Публичный вход: и для Tauri-команды, и для локального HTTP-сервера
// ---------------------------------------------------------------------------

/// Вернуть новые сообщения (seq > since) и текущее состояние. Быстрая, не блокирует.
/// При первом вызове для канала запускает фоновое чтение.
pub fn poll(channel: &str, video: &str, since: u64) -> PollResult {
    let key = format!("{}|{}", channel.trim().to_lowercase(), video.trim());
    let sess: Shared = {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        map.entry(key)
            .or_insert_with(|| {
                Arc::new(Mutex::new(Session {
                    state: "searching".into(),
                    message: "запуск…".into(),
                    seq: 0,
                    buf: VecDeque::new(),
                    last_seen: Instant::now(),
                    running: false,
                }))
            })
            .clone()
    };

    let need_worker = {
        let mut g = lock(&sess);
        g.last_seen = Instant::now();
        if g.running {
            false
        } else {
            g.running = true;
            true
        }
    };
    if need_worker {
        let (c, v) = (channel.to_string(), video.to_string());
        tauri::async_runtime::spawn(worker(sess.clone(), c, v));
    }

    let g = lock(&sess);
    let since = if since > g.seq { 0 } else { since };
    PollResult {
        state: g.state.clone(),
        message: g.message.clone(),
        next: g.seq,
        messages: g.buf.iter().filter(|m| m.seq > since).cloned().collect(),
    }
}

/// Tauri-команда для окна виджета внутри Hub (`invoke("yt_chat_poll", ...)`).
#[tauri::command]
pub fn yt_chat_poll(channel: String, video_id: Option<String>, since: Option<u64>) -> PollResult {
    poll(&channel, video_id.as_deref().unwrap_or(""), since.unwrap_or(0))
}

// ---------------------------------------------------------------------------
// Фоновый воркер
// ---------------------------------------------------------------------------

async fn worker(sess: Shared, channel: String, video_override: String) {
    let client = match reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            set_state(&sess, "error", &format!("HTTP-клиент не создан: {e}"));
            lock(&sess).running = false;
            return;
        }
    };

    loop {
        if is_idle(&sess) {
            let mut g = lock(&sess);
            g.running = false;
            g.buf.clear();
            g.state = "idle".into();
            g.message = String::new();
            return;
        }

        set_state(&sess, "searching", "ищу трансляцию…");
        let found = if !video_override.trim().is_empty() {
            Ok(Some(extract_video_id(&video_override)))
        } else {
            resolve_live(&client, &channel).await
        };

        match found {
            Ok(Some(id)) => {
                match run_chat(&client, &sess, &id).await {
                    Ok(()) => set_state(&sess, "offline", "трансляция завершилась, жду следующую…"),
                    Err(e) => set_state(&sess, "error", &e),
                }
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
            Ok(None) => {
                set_state(&sess, "offline", "эфира сейчас нет, жду…");
                tokio::time::sleep(Duration::from_secs(20)).await;
            }
            Err(e) => {
                set_state(&sess, "error", &e);
                tokio::time::sleep(Duration::from_secs(20)).await;
            }
        }
    }
}

fn cap(text: &str, pat: &str) -> Option<String> {
    Regex::new(pat)
        .ok()?
        .captures(text)?
        .get(1)
        .map(|m| m.as_str().to_string())
}

fn extract_video_id(input: &str) -> String {
    cap(input, r"(?:v=|youtu\.be/|/live/)([\w-]{11})").unwrap_or_else(|| input.trim().to_string())
}

/// "@handle", "UC…", ссылка на канал → путь вида "@handle" / "channel/UC…".
fn channel_path(input: &str) -> String {
    let t = input.trim().trim_end_matches('/');
    let t = t.split(|c: char| c == '?' || c == '#').next().unwrap_or(t);
    let rest = match t.find("youtube.com/") {
        Some(i) => &t[i + "youtube.com/".len()..],
        None => t,
    };
    let mut rest = rest.trim_matches('/').to_string();
    for suffix in ["/live", "/streams", "/featured", "/videos"] {
        if let Some(stripped) = rest.strip_suffix(suffix) {
            rest = stripped.to_string();
        }
    }
    if rest.starts_with('@') || rest.starts_with("channel/") || rest.starts_with("c/") || rest.starts_with("user/") {
        rest
    } else if rest.starts_with("UC") && rest.len() == 24 {
        format!("channel/{rest}")
    } else {
        format!("@{rest}")
    }
}

/// Ищет идущую сейчас трансляцию канала. Ok(None) — эфира нет.
async fn resolve_live(client: &reqwest::Client, channel: &str) -> Result<Option<String>, String> {
    if channel.trim().is_empty() {
        return Err("не указан канал YouTube".into());
    }
    let url = format!("https://www.youtube.com/{}/live", channel_path(channel));
    let resp = client
        .get(&url)
        .header("Cookie", COOKIE)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("YouTube недоступен: {e}"))?;
    if resp.status().as_u16() == 404 {
        return Err("канал не найден — проверь ссылку или @handle".into());
    }
    let final_url = resp.url().to_string();
    let html = resp.text().await.map_err(|e| format!("не прочитан ответ YouTube: {e}"))?;

    if !html.contains("\"isLiveNow\":true") {
        return Ok(None);
    }
    Ok(cap(&final_url, r"[?&]v=([\w-]{11})").or_else(|| {
        cap(
            &html,
            r#"<link rel="canonical" href="https://www\.youtube\.com/watch\?v=([\w-]{11})""#,
        )
    }))
}

// ---------------------------------------------------------------------------
// Чтение чата одной трансляции
// ---------------------------------------------------------------------------

fn extract_continuation(arr: &Value) -> Option<(String, u64)> {
    for c in arr.as_array()? {
        for kind in ["invalidationContinuationData", "timedContinuationData", "reloadContinuationData"] {
            if let Some(token) = c[kind]["continuation"].as_str() {
                let timeout = c[kind]["timeoutMs"].as_u64().unwrap_or(3000);
                return Some((token.to_string(), timeout));
            }
        }
    }
    None
}

async fn run_chat(client: &reqwest::Client, sess: &Shared, video_id: &str) -> Result<(), String> {
    let url = format!("https://www.youtube.com/live_chat?is_popout=1&v={video_id}");
    let html = client
        .get(&url)
        .header("Cookie", COOKIE)
        .header("Accept-Language", "ru,en;q=0.8")
        .send()
        .await
        .map_err(|e| format!("не открылась страница чата: {e}"))?
        .text()
        .await
        .map_err(|e| format!("не прочитана страница чата: {e}"))?;

    let api_key = cap(&html, r#""INNERTUBE_API_KEY":"([^"]+)""#)
        .ok_or("не найден INNERTUBE_API_KEY — YouTube изменил страницу чата")?;
    let version = cap(&html, r#""INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)""#)
        .unwrap_or_else(|| "2.20240101.00.00".to_string());
    let init = cap(&html, r#"(?s)ytInitialData"?\]?\s*=\s*(\{.+?\})\s*;\s*</script>"#)
        .ok_or("не найден ytInitialData — у трансляции нет чата или YouTube изменил страницу")?;
    let data: Value = serde_json::from_str(&init).map_err(|e| format!("ytInitialData не разобран: {e}"))?;

    let lcr = &data["contents"]["liveChatRenderer"];
    if lcr.is_null() {
        return Err("у этой трансляции нет чата (или он выключен)".into());
    }

    let mut seen: HashSet<String> = HashSet::new();
    push_actions(sess, &lcr["actions"], &mut seen);
    let mut cont = extract_continuation(&lcr["continuations"]);
    set_state(sess, "connected", &format!("эфир {video_id}"));

    let endpoint = format!("https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key={api_key}&prettyPrint=false");
    let mut fails = 0u32;

    while let Some((token, timeout)) = cont.take() {
        if is_idle(sess) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(timeout.clamp(1500, 8000))).await;

        let body = json!({
            "context": { "client": { "clientName": "WEB", "clientVersion": version, "hl": "ru" } },
            "continuation": token,
        });
        let result: Result<Value, String> = async {
            let r = client
                .post(&endpoint)
                .header("Cookie", COOKIE)
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !r.status().is_success() {
                return Err(format!("HTTP {}", r.status()));
            }
            r.json::<Value>().await.map_err(|e| e.to_string())
        }
        .await;

        match result {
            Err(e) => {
                fails += 1;
                if fails >= 5 {
                    return Err(format!("чат YouTube не отвечает: {e}"));
                }
                cont = Some((token, 3000));
            }
            Ok(v) => {
                fails = 0;
                let lc = &v["continuationContents"]["liveChatContinuation"];
                if lc.is_null() {
                    return Ok(()); // чат закрыт — эфир закончился
                }
                push_actions(sess, &lc["actions"], &mut seen);
                cont = extract_continuation(&lc["continuations"]);
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Разбор сообщений
// ---------------------------------------------------------------------------

fn parse_runs(message: &Value) -> Vec<Run> {
    let mut out = Vec::new();
    if let Some(runs) = message["runs"].as_array() {
        for r in runs {
            if let Some(t) = r["text"].as_str() {
                out.push(Run { text: t.to_string(), emoji: None });
            } else if r["emoji"].is_object() {
                let e = &r["emoji"];
                let id = e["emojiId"].as_str().unwrap_or("");
                if e["isCustomEmoji"].as_bool().unwrap_or(false) {
                    let shortcut = e["shortcuts"][0].as_str().unwrap_or(id).to_string();
                    let thumbs = e["image"]["thumbnails"].as_array();
                    let mut url = thumbs
                        .and_then(|t| t.last())
                        .and_then(|t| t["url"].as_str())
                        .unwrap_or("")
                        .to_string();
                    if url.starts_with("//") {
                        url = format!("https:{url}");
                    }
                    out.push(Run { text: shortcut, emoji: if url.is_empty() { None } else { Some(url) } });
                } else {
                    // обычный юникод-эмодзи: emojiId — сам символ
                    out.push(Run { text: id.to_string(), emoji: None });
                }
            }
        }
    }
    out
}

fn parse_badges(r: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(list) = r["authorBadges"].as_array() {
        for b in list {
            let br = &b["liveChatAuthorBadgeRenderer"];
            match br["icon"]["iconType"].as_str() {
                Some("OWNER") => out.push("owner".to_string()),
                Some("MODERATOR") => out.push("moderator".to_string()),
                Some("VERIFIED") => out.push("verified".to_string()),
                _ => {
                    if br["customThumbnail"].is_object() {
                        out.push("member".to_string());
                    }
                }
            }
        }
    }
    out
}

/// Один `item` из addChatItemAction → сообщение (seq проставляется позже).
fn parse_item(item: &Value) -> Option<ChatMsg> {
    let (r, superchat, runs) = if item["liveChatTextMessageRenderer"].is_object() {
        let r = &item["liveChatTextMessageRenderer"];
        (r, None, parse_runs(&r["message"]))
    } else if item["liveChatPaidMessageRenderer"].is_object() {
        let r = &item["liveChatPaidMessageRenderer"];
        let amount = r["purchaseAmountText"]["simpleText"].as_str().map(|s| s.to_string());
        (r, amount, parse_runs(&r["message"]))
    } else if item["liveChatPaidStickerRenderer"].is_object() {
        let r = &item["liveChatPaidStickerRenderer"];
        let amount = r["purchaseAmountText"]["simpleText"].as_str().map(|s| s.to_string());
        (r, amount, vec![Run { text: "[стикер]".into(), emoji: None }])
    } else if item["liveChatMembershipItemRenderer"].is_object() {
        let r = &item["liveChatMembershipItemRenderer"];
        let mut runs = parse_runs(&r["headerSubtext"]);
        if runs.is_empty() {
            runs.push(Run { text: "стал(а) участником канала".into(), emoji: None });
        }
        (r, None, runs)
    } else {
        return None;
    };

    let id = r["id"].as_str()?.to_string();
    let author = r["authorName"]["simpleText"].as_str().unwrap_or("YouTube").to_string();
    let ts = r["timestampUsec"]
        .as_str()
        .and_then(|s| s.parse::<i64>().ok())
        .map(|us| us / 1000)
        .unwrap_or(0);
    Some(ChatMsg { seq: 0, id, author, runs, badges: parse_badges(r), ts, superchat })
}

fn push_actions(sess: &Shared, actions: &Value, seen: &mut HashSet<String>) {
    let Some(list) = actions.as_array() else { return };
    if seen.len() > 3000 {
        seen.clear();
    }
    let mut g = lock(sess);
    for a in list {
        let Some(mut msg) = parse_item(&a["addChatItemAction"]["item"]) else { continue };
        if !seen.insert(msg.id.clone()) {
            continue;
        }
        g.seq += 1;
        msg.seq = g.seq;
        g.buf.push_back(msg);
        while g.buf.len() > MAX_BUFFER {
            g.buf.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_paths() {
        assert_eq!(channel_path("@name"), "@name");
        assert_eq!(channel_path("name"), "@name");
        assert_eq!(channel_path("https://www.youtube.com/@name/live"), "@name");
        assert_eq!(channel_path("UCabcdefghijklmnopqrstuv"), "channel/UCabcdefghijklmnopqrstuv");
    }

    #[test]
    fn video_ids() {
        assert_eq!(extract_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
        assert_eq!(extract_video_id("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
    }

    #[test]
    fn parses_text_and_custom_emoji() {
        let item = json!({
            "liveChatTextMessageRenderer": {
                "id": "abc",
                "timestampUsec": "1700000000000000",
                "authorName": { "simpleText": "Зритель" },
                "message": { "runs": [
                    { "text": "привет " },
                    { "emoji": { "emojiId": "x/y", "isCustomEmoji": true, "shortcuts": [":kek:"],
                        "image": { "thumbnails": [ { "url": "https://yt3.ggpht.com/a" }, { "url": "https://yt3.ggpht.com/b" } ] } } }
                ]},
                "authorBadges": [ { "liveChatAuthorBadgeRenderer": { "icon": { "iconType": "MODERATOR" } } } ]
            }
        });
        let m = parse_item(&item).expect("parsed");
        assert_eq!(m.author, "Зритель");
        assert_eq!(m.badges, vec!["moderator"]);
        assert_eq!(m.runs.len(), 2);
        assert_eq!(m.runs[1].emoji.as_deref(), Some("https://yt3.ggpht.com/b"));
        assert_eq!(m.ts, 1_700_000_000_000);
    }

    #[test]
    fn parses_superchat() {
        let item = json!({
            "liveChatPaidMessageRenderer": {
                "id": "p1", "authorName": { "simpleText": "Щедрый" },
                "purchaseAmountText": { "simpleText": "₽500.00" },
                "message": { "runs": [ { "text": "спасибо" } ] }
            }
        });
        let m = parse_item(&item).expect("parsed");
        assert_eq!(m.superchat.as_deref(), Some("₽500.00"));
    }
}
