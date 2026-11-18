use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle, ThreadId};
use std::time::Duration;

use crate::error::LinkError;
use crate::{serial, tcp};

pub type LinkId = u32;

/// Why a link went away without the caller asking for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseReason {
    /// The peer closed the connection cleanly (TCP FIN).
    PeerClosed,
    /// A read failed, typically because the adapter was unplugged.
    Error(String),
}

/// Receives every chunk read from the link. Return `false` when the consumer is gone (e.g. the
/// webview reloaded): the link is then closed and its port released.
pub type DataHandler = Box<dyn FnMut(&[u8]) -> bool + Send>;
pub type ClosedHandler = Box<dyn FnOnce(LinkId, CloseReason) + Send>;

/// A duplex byte pipe. `reader` must return `TimedOut`/`WouldBlock` periodically (or be
/// unblocked by `closer`) so the reader thread notices a user-initiated close.
pub struct Endpoint {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    /// Releases OS resources and unblocks a blocked reader.
    pub closer: Box<dyn FnOnce() + Send>,
}

struct Link {
    /// `None` once closed: dropping it releases the OS handle (serial ports are opened with an
    /// exclusive lock, so every clone must be gone before the path can be reopened).
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    closer: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    stop: AtomicBool,
    /// Device path or `host:port`; a new open of the same key replaces this link.
    key: Option<String>,
    reader: Mutex<Option<JoinHandle<()>>>,
    reader_id: Mutex<Option<ThreadId>>,
}

type LinkMap = Arc<Mutex<HashMap<LinkId, Arc<Link>>>>;

#[derive(Default)]
pub struct LinkManager {
    next_id: AtomicU32,
    links: LinkMap,
}

impl LinkManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers an endpoint and starts its reader thread.
    ///
    /// `on_closed` fires only for losses the caller did not request; a `close()` is silent.
    pub fn attach(&self, endpoint: Endpoint, on_data: DataHandler, on_closed: ClosedHandler) -> LinkId {
        self.attach_keyed(None, endpoint, on_data, on_closed)
    }

    fn attach_keyed(&self, key: Option<String>, endpoint: Endpoint, mut on_data: DataHandler, on_closed: ClosedHandler) -> LinkId {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let link = Arc::new(Link {
            writer: Mutex::new(Some(endpoint.writer)),
            closer: Mutex::new(Some(endpoint.closer)),
            stop: AtomicBool::new(false),
            key,
            reader: Mutex::new(None),
            reader_id: Mutex::new(None),
        });
        self.links.lock().unwrap().insert(id, link.clone());

        let links = self.links.clone();
        let mut reader = endpoint.reader;
        let thread_link = link.clone();
        let handle = thread::Builder::new()
            .name(format!("cygnus-link-{id}"))
            .spawn(move || {
                let link = thread_link;
                let mut buf = [0u8; 4096];
                let reason = loop {
                    if link.stop.load(Ordering::Acquire) {
                        return;
                    }
                    match reader.read(&mut buf) {
                        Ok(0) => break CloseReason::PeerClosed,
                        Ok(n) => {
                            if !on_data(&buf[..n]) {
                                break CloseReason::Error("consumer gone".into());
                            }
                        }
                        Err(e) if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                        Err(e) => break CloseReason::Error(e.to_string()),
                    }
                };
                // A read error caused by our own shutdown must stay silent.
                if link.stop.swap(true, Ordering::AcqRel) {
                    return;
                }
                links.lock().unwrap().remove(&id);
                link.release();
                drop(reader);
                on_closed(id, reason);
            })
            .expect("failed to spawn link reader thread");
        *link.reader_id.lock().unwrap() = Some(handle.thread().id());
        *link.reader.lock().unwrap() = Some(handle);
        id
    }

    pub fn open_tcp(
        &self,
        host: &str,
        port: u16,
        timeout: Duration,
        on_data: DataHandler,
        on_closed: ClosedHandler,
    ) -> Result<LinkId, LinkError> {
        let endpoint = tcp::connect(host, port, timeout)?;
        Ok(self.attach_keyed(Some(format!("tcp:{host}:{port}")), endpoint, on_data, on_closed))
    }

    pub fn open_serial(
        &self,
        path: &str,
        baud: u32,
        on_data: DataHandler,
        on_closed: ClosedHandler,
    ) -> Result<LinkId, LinkError> {
        let key = format!("serial:{path}");
        // Reconnect / webview reload: a stale link on the same port would hold its exclusive lock.
        self.close_key(&key);
        let endpoint = serial::open(path, baud)?;
        Ok(self.attach_keyed(Some(key), endpoint, on_data, on_closed))
    }

    /// Writes all bytes in order. Writes to one link are serialised by its writer lock; callers
    /// must also issue them in order (the JS side awaits each write before the next).
    pub fn write(&self, id: LinkId, bytes: &[u8]) -> Result<(), LinkError> {
        let link = self.get(id)?;
        let mut guard = link.writer.lock().unwrap();
        let writer = guard.as_mut().ok_or(LinkError::UnknownLink(id))?;
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }

    /// Closes the link and returns once its port/socket is released (the reader thread has
    /// exited and every handle is dropped), so the same path can be reopened immediately.
    pub fn close(&self, id: LinkId) -> Result<(), LinkError> {
        let link = self.links.lock().unwrap().remove(&id).ok_or(LinkError::UnknownLink(id))?;
        link.stop.store(true, Ordering::Release);
        link.release();
        let me = thread::current().id();
        if *link.reader_id.lock().unwrap() != Some(me) {
            if let Some(h) = link.reader.lock().unwrap().take() {
                let _ = h.join();
            }
        }
        Ok(())
    }

    fn close_key(&self, key: &str) {
        let ids: Vec<LinkId> = self
            .links
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, l)| l.key.as_deref() == Some(key))
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            let _ = self.close(id);
        }
    }

    /// Number of open links (diagnostics, tests).
    pub fn len(&self) -> usize {
        self.links.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Closes every link; used on application exit.
    pub fn close_all(&self) {
        let ids: Vec<LinkId> = self.links.lock().unwrap().keys().copied().collect();
        for id in ids {
            let _ = self.close(id);
        }
    }

    fn get(&self, id: LinkId) -> Result<Arc<Link>, LinkError> {
        // (lookup only; the writer lock is taken by the caller)
        self.links.lock().unwrap().get(&id).cloned().ok_or(LinkError::UnknownLink(id))
    }
}

impl Link {
    /// Drops the writer handle and runs the closer (unblocks a blocked reader). Idempotent.
    fn release(&self) {
        self.writer.lock().unwrap().take();
        if let Some(closer) = self.closer.lock().unwrap().take() {
            closer();
        }
    }
}
