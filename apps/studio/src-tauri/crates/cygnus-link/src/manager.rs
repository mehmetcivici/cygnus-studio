use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
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

pub type DataHandler = Box<dyn FnMut(&[u8]) + Send>;
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
    writer: Mutex<Box<dyn Write + Send>>,
    closer: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    stop: AtomicBool,
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
    pub fn attach(&self, endpoint: Endpoint, mut on_data: DataHandler, on_closed: ClosedHandler) -> LinkId {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let link = Arc::new(Link {
            writer: Mutex::new(endpoint.writer),
            closer: Mutex::new(Some(endpoint.closer)),
            stop: AtomicBool::new(false),
        });
        self.links.lock().unwrap().insert(id, link.clone());

        let links = self.links.clone();
        let mut reader = endpoint.reader;
        thread::Builder::new()
            .name(format!("cygnus-link-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 4096];
                let reason = loop {
                    if link.stop.load(Ordering::Acquire) {
                        return;
                    }
                    match reader.read(&mut buf) {
                        Ok(0) => break CloseReason::PeerClosed,
                        Ok(n) => on_data(&buf[..n]),
                        Err(e) if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                        Err(e) => break CloseReason::Error(e.to_string()),
                    }
                };
                // A read error caused by our own shutdown must stay silent.
                if link.stop.swap(true, Ordering::AcqRel) {
                    return;
                }
                links.lock().unwrap().remove(&id);
                if let Some(closer) = link.closer.lock().unwrap().take() {
                    closer();
                }
                on_closed(id, reason);
            })
            .expect("failed to spawn link reader thread");
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
        Ok(self.attach(endpoint, on_data, on_closed))
    }

    pub fn open_serial(
        &self,
        path: &str,
        baud: u32,
        on_data: DataHandler,
        on_closed: ClosedHandler,
    ) -> Result<LinkId, LinkError> {
        let endpoint = serial::open(path, baud)?;
        Ok(self.attach(endpoint, on_data, on_closed))
    }

    pub fn write(&self, id: LinkId, bytes: &[u8]) -> Result<(), LinkError> {
        let link = self.get(id)?;
        let mut writer = link.writer.lock().unwrap();
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }

    pub fn close(&self, id: LinkId) -> Result<(), LinkError> {
        let link = self.links.lock().unwrap().remove(&id).ok_or(LinkError::UnknownLink(id))?;
        link.stop.store(true, Ordering::Release);
        if let Some(closer) = link.closer.lock().unwrap().take() {
            closer();
        }
        Ok(())
    }

    /// Closes every link; used on application exit.
    pub fn close_all(&self) {
        let ids: Vec<LinkId> = self.links.lock().unwrap().keys().copied().collect();
        for id in ids {
            let _ = self.close(id);
        }
    }

    fn get(&self, id: LinkId) -> Result<Arc<Link>, LinkError> {
        self.links.lock().unwrap().get(&id).cloned().ok_or(LinkError::UnknownLink(id))
    }
}
