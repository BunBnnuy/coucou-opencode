// Chat API clients — the same integration as ClaudeService.swift: multi-turn
// chat, files sent inline, and a choice of provider.
//
//   * `anthropic` — the Claude Messages API, with web search.
//   * `opencode`  — the OpenCode Go / Zen gateway (OpenAI-compatible chat
//     completions), used with an OpenCode API key and an open model such as
//     deepseek-v4.1-flash.
//
// Everything happens here rather than in the island: the API key never leaves
// the Credential Manager, and file bytes never cross the IPC boundary.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::secrets;

const ANTHROPIC_ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Server-side fallback: on a policy decline the API retries the same request on
/// a fallback model inside the same call, so the island never shows a dead end.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// OpenCode Go / Zen gateway — OpenAI-compatible chat completions.
const OPENCODE_ENDPOINT: &str = "https://opencode.ai/zen/go/v1/chat/completions";
const MAX_TOKENS: u32 = 4096;
/// Text and code files are inlined up to this size; beyond it the head is sent
/// with a truncation note, so the model always sees *something* useful.
const MAX_INLINE_TEXT: usize = 1_000_000;
/// Identifies this client to the gateway, as OpenCode Go asks.
const USER_AGENT: &str = "coucou/0.1.1";

pub const DEFAULT_MODEL: &str = "claude-opus-5";
pub const DEFAULT_OPENCODE_MODEL: &str = "deepseek-v4.1-flash";
pub const PROVIDER_ANTHROPIC: &str = "anthropic";
pub const PROVIDER_OPENCODE: &str = "opencode";

const SYSTEM_PROMPT: &str = "You are Mochi, a personal AI assistant living at the top of the user's screen. \
You can help with absolutely anything — research, coding, finding places, recommendations, tasks, questions. \
Respond in the user's language. Be thorough and complete — use as much detail as the task requires. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

pub struct Chat {
    /// Full multi-turn history, in the shape of the active provider.
    messages: Mutex<Vec<Value>>,
    /// Which provider shaped that history; switching provider clears it.
    provider: Mutex<Option<String>>,
    /// Stable per-conversation id OpenCode Go asks clients to send.
    session: String,
}

impl Default for Chat {
    fn default() -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        Self {
            messages: Mutex::new(Vec::new()),
            provider: Mutex::new(None),
            session: format!("coucou-{nanos:x}"),
        }
    }
}

impl Chat {
    pub fn reset(&self) {
        self.messages.lock().unwrap().clear();
        *self.provider.lock().unwrap() = None;
    }

    /// Remembers the provider, clearing history when it is not the one that
    /// shaped the stored messages (Anthropic blocks are not OpenAI messages).
    fn switch_to(&self, provider: &str) {
        let mut current = self.provider.lock().unwrap();
        if current.as_deref() != Some(provider) {
            self.messages.lock().unwrap().clear();
        }
        *current = Some(provider.to_string());
    }

    fn is_empty(&self) -> bool {
        self.messages.lock().unwrap().is_empty()
    }

    fn push(&self, message: Value) {
        self.messages.lock().unwrap().push(message);
    }

    fn pop(&self) {
        self.messages.lock().unwrap().pop();
    }

    fn snapshot(&self) -> Vec<Value> {
        self.messages.lock().unwrap().clone()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatContext {
    File { name: String, path: String },
    Window { app_name: String, title: String, url: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
}

/// One chat turn. Returns the assistant's text, or a message the island shows
/// in the note view.
pub async fn send(
    chat: &Chat,
    provider: &str,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    chat.switch_to(provider);
    if provider == PROVIDER_OPENCODE {
        send_opencode(chat, model, query, context).await
    } else {
        send_anthropic(chat, model, query, context).await
    }
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async fn send_anthropic(
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let key = secrets::get("anthropic-api-key")
        .ok_or_else(|| "API key missing. Open settings.".to_string())?;
    let model = if model.trim().is_empty() { DEFAULT_MODEL } else { model };

    let mut content: Vec<Value> = Vec::new();
    if chat.is_empty() {
        context_blocks(&context, &mut content, |path| file_block(path));
    }
    content.push(json!({ "type": "text", "text": query }));
    chat.push(json!({ "role": "user", "content": content }));

    let body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "tools": [{ "type": "web_search_20260209", "name": "web_search", "max_uses": 5 }],
        "fallbacks": "default",
        "messages": chat.snapshot(),
    });

    let response = match call_anthropic(&key, &body).await {
        Ok(v) => v,
        Err(err) => {
            chat.pop(); // keep the history consistent with what the model saw
            return Err(err);
        }
    };

    // A policy decline comes back as HTTP 200 with stop_reason "refusal".
    if response.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        chat.pop();
        let why = response
            .get("stop_details")
            .and_then(|d| d.get("explanation"))
            .and_then(Value::as_str)
            .unwrap_or("Claude declined this one.");
        return Err(why.to_string());
    }

    let Some(blocks) = response.get("content").and_then(Value::as_array).cloned() else {
        chat.pop();
        return Err("Unexpected API response.".into());
    };

    chat.push(json!({ "role": "assistant", "content": blocks.clone() }));

    let text = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if text.is_empty() {
        return Err("No response text.".into());
    }
    Ok(ChatReply { text })
}

async fn call_anthropic(key: &str, body: &Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(ANTHROPIC_ENDPOINT)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = error_message(&text);
        return Err(format!("Claude API {status}: {detail}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad API response: {e}"))
}

// ── OpenCode Go / Zen ─────────────────────────────────────────────────────────

async fn send_opencode(
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let key = secrets::get("opencode-api-key")
        .ok_or_else(|| "OpenCode API key missing. Open settings.".to_string())?;
    let model = if model.trim().is_empty() { DEFAULT_OPENCODE_MODEL } else { model };

    let mut content: Vec<Value> = Vec::new();
    if chat.is_empty() {
        context_blocks(&context, &mut content, opencode_file_block);
    }
    content.push(json!({ "type": "text", "text": query }));

    // A lone text block can be a plain string, which every compatible gateway accepts.
    let user_content = if content.len() == 1 && content[0].get("type").and_then(Value::as_str) == Some("text") {
        json!(content[0].get("text").and_then(Value::as_str).unwrap_or(""))
    } else {
        Value::Array(content)
    };
    chat.push(json!({ "role": "user", "content": user_content }));

    let mut messages = vec![json!({ "role": "system", "content": SYSTEM_PROMPT })];
    messages.extend(chat.snapshot());
    let body = json!({ "model": model, "max_tokens": MAX_TOKENS, "messages": messages });

    let response = match call_opencode(&key, &chat.session, &body).await {
        Ok(v) => v,
        Err(err) => {
            chat.pop();
            return Err(err);
        }
    };

    let text = response
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        chat.pop();
        return Err("No response text.".into());
    }
    chat.push(json!({ "role": "assistant", "content": text.clone() }));
    Ok(ChatReply { text })
}

async fn call_opencode(key: &str, session: &str, body: &Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(OPENCODE_ENDPOINT)
        .header("authorization", format!("Bearer {key}"))
        .header("content-type", "application/json")
        .header("user-agent", USER_AGENT)
        .header("x-opencode-session", session)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("OpenCode API {status}: {}", error_message(&text)));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad API response: {e}"))
}

/// Both APIs put a human-readable reason under `error.message`.
fn error_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(200).collect())
}

// ── Files ─────────────────────────────────────────────────────────────────────

/// File / window context rides along with the first message only, exactly like
/// ClaudeService.chat(). `block` turns a path into a provider-shaped block.
fn context_blocks(
    context: &Option<ChatContext>,
    content: &mut Vec<Value>,
    block: impl Fn(&str) -> Option<Value>,
) {
    match context {
        Some(ChatContext::File { name, path }) => {
            if let Some(b) = block(path) {
                content.push(b);
            }
            content.push(json!({ "type": "text", "text": format!("File: {name}") }));
        }
        Some(ChatContext::Window { app_name, title, url }) => {
            let mut text = format!("Context — App: {app_name}, Window: {title}");
            if let Some(url) = url {
                text.push_str(&format!(", URL: {url}"));
            }
            content.push(json!({ "type": "text", "text": text }));
        }
        None => {}
    }
}

/// Anthropic shape: PDF → document, image → image, text/code → inline text.
/// Mirrors readFileAsBlock() in ClaudeService.swift.
fn file_block(path: &str) -> Option<Value> {
    if let Some((ext, media)) = media_type(path) {
        let bytes = std::fs::read(path).ok()?;
        let block_type = if ext == "pdf" { "document" } else { "image" };
        return Some(json!({
            "type": block_type,
            "source": { "type": "base64", "media_type": media, "data": base64(&bytes) },
        }));
    }
    text_block(path)
}

/// OpenAI-compatible shape: image → `image_url` data URL, text/code inline.
/// PDFs are not supported by chat completions, so they are skipped.
fn opencode_file_block(path: &str) -> Option<Value> {
    if let Some((ext, media)) = media_type(path) {
        if ext == "pdf" {
            return None;
        }
        let bytes = std::fs::read(path).ok()?;
        return Some(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{media};base64,{}", base64(&bytes)) },
        }));
    }
    text_block(path)
}

/// Text/code inline block. Reads at most `MAX_INLINE_TEXT` bytes and says so
/// when the file was cut, instead of dropping the content entirely.
fn text_block(path: &str) -> Option<Value> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; MAX_INLINE_TEXT];
    let read = std::io::Read::read(&mut file, &mut buf).ok()?;
    buf.truncate(read);
    let text = String::from_utf8_lossy(&buf);
    let note = if read == MAX_INLINE_TEXT {
        format!("\n… [truncated at {MAX_INLINE_TEXT} bytes; ask for a specific part if you need more]")
    } else {
        String::new()
    };
    Some(json!({ "type": "text", "text": format!("File contents:\n{text}{note}") }))
}

fn media_type(path: &str) -> Option<(String, &'static str)> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let media = match ext.as_str() {
        "pdf" => "application/pdf",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    };
    Some((ext, media))
}

/// Small standalone base64 encoder — not worth another dependency.
/// Also used for Stripe's basic auth.
pub(crate) fn base64_for(bytes: &[u8]) -> String {
    base64(bytes)
}

/// Decoder for the HTML5 drop path: the page base64s the dropped file because
/// Tauri's IPC is JSON. Rejects anything that is not canonical base64.
pub(crate) fn base64_to_bytes(text: &str) -> Option<Vec<u8>> {
    let value = |b: u8| -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let bytes: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().filter(|b| **b == b'=').count();
        if pad > 2 {
            return None;
        }
        let mut n = 0u32;
        for (i, b) in chunk.iter().enumerate() {
            n |= if *b == b'=' {
                if i < 2 {
                    return None;
                }
                0
            } else {
                value(*b)? as u32
            } << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Some(out)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_decodes_what_it_encodes() {
        for input in [
            &b""[..],
            b"f",
            b"fo",
            b"foo",
            b"foob",
            b"foobar",
            &[0u8, 1, 2, 253, 254, 255],
        ] {
            let encoded = base64(input);
            assert_eq!(base64_to_bytes(&encoded).as_deref(), Some(input));
        }
        assert!(base64_to_bytes("not base64!").is_none());
        assert!(base64_to_bytes("Zg=").is_none());
    }

    #[test]
    fn opencode_uses_an_openai_image_block() {
        let dir = std::env::temp_dir().join(format!("coucou-chat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("pixel.png");
        std::fs::write(&png, [0x89, 0x50, 0x4E, 0x47]).unwrap();
        let block = opencode_file_block(png.to_str().unwrap()).expect("png block");
        assert_eq!(block["type"], "image_url");
        assert!(block["image_url"]["url"].as_str().unwrap().starts_with("data:image/png;base64,"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn text_files_reach_both_providers_and_big_ones_are_truncated() {
        let dir = std::env::temp_dir().join(format!("coucou-text-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let small = dir.join("order.json");
        std::fs::write(&small, br#"{"items":[{"sku":"a"}]}"#).unwrap();
        for block in [
            file_block(small.to_str().unwrap()),
            opencode_file_block(small.to_str().unwrap()),
        ] {
            let block = block.expect("a text file must inline, not vanish");
            let text = block["text"].as_str().unwrap();
            assert!(text.contains(r#""items""#), "content missing: {text}");
            assert!(!text.contains("truncated"));
        }

        let big = dir.join("big.json");
        std::fs::write(&big, vec![b'a'; MAX_INLINE_TEXT + 10]).unwrap();
        let block = text_block(big.to_str().unwrap()).unwrap();
        assert!(block["text"].as_str().unwrap().contains("truncated at"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn switching_provider_clears_history() {        let chat = Chat::default();
        chat.switch_to(PROVIDER_ANTHROPIC);
        chat.push(json!({ "role": "user", "content": "hi" }));
        assert!(!chat.is_empty());
        chat.switch_to(PROVIDER_ANTHROPIC);
        assert!(!chat.is_empty(), "same provider keeps the conversation");
        chat.switch_to(PROVIDER_OPENCODE);
        assert!(chat.is_empty(), "history must not leak across providers");
    }
}
