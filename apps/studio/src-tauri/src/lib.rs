//! Thin Tauri layer over `cygnus-link`. Connection logic lives in that crate so it can be
//! tested without a GUI; this file only maps commands and events.
//!
//! Wire contract (see `src/core/transports/tauri.ts`):
//! - incoming bytes travel through the `on_data` channel as raw `ArrayBuffer`s (no JSON/base64);
//! - outgoing bytes are the raw request body of `link_write`, the link id is the `x-link-id` header;
//! - an unrequested loss is announced with the `link://closed` event `{ id, error }`.

use std::time::Duration;

use cygnus_link::{CloseReason, LinkId, LinkManager, SerialPortEntry};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, Emitter, RunEvent, State};

const CLOSED_EVENT: &str = "link://closed";
const ID_HEADER: &str = "x-link-id";
const DEFAULT_TCP_TIMEOUT_MS: u64 = 3000;

#[derive(Clone, Serialize)]
struct ClosedPayload {
    id: LinkId,
    /// `None` when the peer closed the connection cleanly.
    error: Option<String>,
}

fn handlers(
    app: AppHandle,
    on_data: Channel<InvokeResponseBody>,
) -> (cygnus_link::DataHandler, cygnus_link::ClosedHandler) {
    (
        Box::new(move |chunk| {
            // A failed send means the webview is gone; the app is shutting down.
            let _ = on_data.send(InvokeResponseBody::Raw(chunk.to_vec()));
        }),
        Box::new(move |id, reason| {
            let error = match reason {
                CloseReason::PeerClosed => None,
                CloseReason::Error(m) => Some(m),
            };
            let _ = app.emit(CLOSED_EVENT, ClosedPayload { id, error });
        }),
    )
}

#[tauri::command]
async fn link_list_serial() -> Result<Vec<SerialPortEntry>, String> {
    cygnus_link::list_serial_ports().map_err(|e| e.to_string())
}

#[tauri::command]
async fn link_open_serial(
    app: AppHandle,
    links: State<'_, LinkManager>,
    path: String,
    baud: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<LinkId, String> {
    let (data, closed) = handlers(app, on_data);
    links.open_serial(&path, baud, data, closed).map_err(|e| e.to_string())
}

#[tauri::command]
async fn link_open_tcp(
    app: AppHandle,
    links: State<'_, LinkManager>,
    host: String,
    port: u16,
    timeout_ms: Option<u64>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<LinkId, String> {
    let (data, closed) = handlers(app, on_data);
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TCP_TIMEOUT_MS));
    links.open_tcp(&host, port, timeout, data, closed).map_err(|e| e.to_string())
}

#[tauri::command]
async fn link_write(links: State<'_, LinkManager>, request: Request<'_>) -> Result<(), String> {
    let id: LinkId = request
        .headers()
        .get(ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| format!("missing or invalid {ID_HEADER} header"))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("link_write expects a raw binary body".into());
    };
    links.write(id, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
async fn link_close(links: State<'_, LinkManager>, id: LinkId) -> Result<(), String> {
    links.close(id).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(LinkManager::new())
        .invoke_handler(tauri::generate_handler![
            link_list_serial,
            link_open_serial,
            link_open_tcp,
            link_write,
            link_close
        ])
        .build(tauri::generate_context!())
        .expect("error while building Cygnus Studio")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                tauri::Manager::state::<LinkManager>(app).close_all();
            }
        });
}
