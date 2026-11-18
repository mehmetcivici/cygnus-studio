//! Thin Tauri layer over `cygnus-link`. Connection logic lives in that crate so it can be
//! tested without a GUI; this file maps commands and events and validates their inputs.
//!
//! Wire contract (see `src/core/transports/tauri.ts`):
//! - incoming bytes travel through the `on_data` channel as raw `ArrayBuffer`s (no JSON/base64);
//! - outgoing bytes are the raw request body of `link_write`, the link id is the `x-link-id` header;
//!   the JS side awaits each write before sending the next, so frames keep their order;
//! - an unrequested loss is announced with the `link://closed` event `{ id, error }`;
//! - a page (re)load closes every link: a reloaded webview has forgotten its ids, and a stale
//!   serial link would keep the port's exclusive lock.

use std::time::Duration;

use cygnus_link::{CloseReason, LinkId, LinkManager, SerialPortEntry};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

const CLOSED_EVENT: &str = "link://closed";
const ID_HEADER: &str = "x-link-id";
const DEFAULT_TCP_TIMEOUT_MS: u64 = 3000;
const TCP_TIMEOUT_RANGE_MS: (u64, u64) = (100, 10_000);
/// slcan adapters and USB CDC: anything else is a typo or an attack on the port driver.
const ALLOWED_BAUDS: &[u32] = &[9_600, 19_200, 38_400, 57_600, 115_200, 230_400, 250_000, 460_800, 500_000, 921_600, 1_000_000, 2_000_000, 3_000_000];
const MAX_WRITE_BYTES: usize = 64 * 1024;

#[derive(Clone, Serialize)]
struct ClosedPayload {
    id: LinkId,
    /// `None` when the peer closed the connection cleanly.
    error: Option<String>,
}

fn handlers(app: AppHandle, on_data: Channel<InvokeResponseBody>) -> (cygnus_link::DataHandler, cygnus_link::ClosedHandler) {
    (
        // A failed send means the webview is gone (reload, close): the link closes itself.
        Box::new(move |chunk| on_data.send(InvokeResponseBody::Raw(chunk.to_vec())).is_ok()),
        Box::new(move |id, reason| {
            let error = match reason {
                CloseReason::PeerClosed => None,
                CloseReason::Error(m) => Some(m),
            };
            let _ = app.emit(CLOSED_EVENT, ClosedPayload { id, error });
        }),
    )
}

/// Serial device path: `/dev/tty…`, `/dev/cu…` or `COMn` (also `\\.\COMn`).
fn validate_serial_path(path: &str) -> Result<(), String> {
    let ok = !path.is_empty()
        && path.len() <= 256
        && !path.contains('\0')
        && (path.starts_with("/dev/") || path.to_ascii_uppercase().starts_with("COM") || path.starts_with(r"\\.\COM"))
        && !path.contains("..");
    if ok {
        Ok(())
    } else {
        Err(format!("invalid serial port path: {path:?}"))
    }
}

fn validate_baud(baud: u32) -> Result<(), String> {
    if ALLOWED_BAUDS.contains(&baud) {
        Ok(())
    } else {
        Err(format!("unsupported baud rate {baud}"))
    }
}

/// Host name or IP literal: 1–253 chars of `[A-Za-z0-9.-:]` (IPv6 without brackets).
fn validate_host(host: &str) -> Result<(), String> {
    let ok = !host.is_empty() && host.len() <= 253 && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'));
    if ok {
        Ok(())
    } else {
        Err(format!("invalid host {host:?}"))
    }
}

fn tcp_timeout(ms: Option<u64>) -> Duration {
    Duration::from_millis(ms.unwrap_or(DEFAULT_TCP_TIMEOUT_MS).clamp(TCP_TIMEOUT_RANGE_MS.0, TCP_TIMEOUT_RANGE_MS.1))
}

/// Blocking I/O (port enumeration, open, connect with a timeout) must not stall the async
/// runtime's worker threads, which also carry `link_write`.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn link_list_serial() -> Result<Vec<SerialPortEntry>, String> {
    blocking(|| cygnus_link::list_serial_ports().map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn link_open_serial(app: AppHandle, path: String, baud: u32, on_data: Channel<InvokeResponseBody>) -> Result<LinkId, String> {
    validate_serial_path(&path)?;
    validate_baud(baud)?;
    let (data, closed) = handlers(app.clone(), on_data);
    blocking(move || app.state::<LinkManager>().open_serial(&path, baud, data, closed).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn link_open_tcp(
    app: AppHandle,
    host: String,
    port: u16,
    timeout_ms: Option<u64>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<LinkId, String> {
    validate_host(&host)?;
    if port == 0 {
        return Err("invalid port 0".into());
    }
    let (data, closed) = handlers(app.clone(), on_data);
    let timeout = tcp_timeout(timeout_ms);
    blocking(move || app.state::<LinkManager>().open_tcp(&host, port, timeout, data, closed).map_err(|e| e.to_string())).await
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
    if bytes.len() > MAX_WRITE_BYTES {
        return Err(format!("write of {} bytes exceeds {MAX_WRITE_BYTES}", bytes.len()));
    }
    links.write(id, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
async fn link_close(app: AppHandle, id: LinkId) -> Result<(), String> {
    // close() joins the reader thread (≤ one read timeout): keep it off the async workers.
    blocking(move || app.state::<LinkManager>().close(id).map_err(|e| e.to_string())).await
}

pub fn run() {
    tauri::Builder::default()
        .manage(LinkManager::new())
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                webview.state::<LinkManager>().close_all();
            }
        })
        .invoke_handler(tauri::generate_handler![link_list_serial, link_open_serial, link_open_tcp, link_write, link_close])
        .build(tauri::generate_context!())
        .expect("error while building Cygnus Studio")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<LinkManager>().close_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serial_paths() {
        for ok in ["/dev/ttyACM0", "/dev/cu.usbmodem1101", "COM3", r"\\.\COM12"] {
            assert!(validate_serial_path(ok).is_ok(), "{ok}");
        }
        for bad in ["", "/etc/passwd", "/dev/../etc/passwd", "foo", "/dev/tty\0x"] {
            assert!(validate_serial_path(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn bauds_and_hosts() {
        assert!(validate_baud(115_200).is_ok());
        assert!(validate_baud(0).is_err());
        assert!(validate_baud(123).is_err());
        assert!(validate_host("172.22.11.2").is_ok());
        assert!(validate_host("roborio-9473-frc.local").is_ok());
        assert!(validate_host("fe80::1").is_ok());
        assert!(validate_host("").is_err());
        assert!(validate_host("a b").is_err());
        assert!(validate_host(&"a".repeat(300)).is_err());
    }

    #[test]
    fn tcp_timeout_is_clamped() {
        assert_eq!(tcp_timeout(None), Duration::from_millis(3000));
        assert_eq!(tcp_timeout(Some(0)), Duration::from_millis(100));
        assert_eq!(tcp_timeout(Some(u64::MAX)), Duration::from_millis(10_000));
    }
}
