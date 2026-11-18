use std::io::{self, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use cygnus_link::{CloseReason, Endpoint, LinkError, LinkManager};

const WAIT: Duration = Duration::from_secs(5);

/// Fake serial port: reads come from a channel, writes are captured.
struct FakeReader {
    rx: Receiver<io::Result<Vec<u8>>>,
}

impl Read for FakeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.rx.recv_timeout(Duration::from_millis(10)) {
            Ok(Ok(chunk)) => {
                buf[..chunk.len()].copy_from_slice(&chunk);
                Ok(chunk.len())
            }
            Ok(Err(e)) => Err(e),
            Err(RecvTimeoutError::Timeout) => Err(io::ErrorKind::TimedOut.into()),
            Err(RecvTimeoutError::Disconnected) => Ok(0),
        }
    }
}

struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl Write for CaptureWriter {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

type FakeEndpoint = (Endpoint, Sender<io::Result<Vec<u8>>>, Arc<Mutex<Vec<u8>>>, Arc<Mutex<bool>>);

fn fake_endpoint() -> FakeEndpoint {
    let (tx, rx) = mpsc::channel();
    let written = Arc::new(Mutex::new(Vec::new()));
    let closed = Arc::new(Mutex::new(false));
    let c = closed.clone();
    let ep = Endpoint {
        reader: Box::new(FakeReader { rx }),
        writer: Box::new(CaptureWriter(written.clone())),
        closer: Box::new(move || *c.lock().unwrap() = true),
    };
    (ep, tx, written, closed)
}

#[test]
fn fake_stream_delivers_data_and_captures_writes() {
    let mgr = LinkManager::new();
    let (ep, tx, written, _) = fake_endpoint();
    let (dtx, drx) = mpsc::channel::<Vec<u8>>();
    let id = mgr.attach(ep, Box::new(move |b| dtx.send(b.to_vec()).is_ok()), Box::new(|_, _| {}));

    tx.send(Ok(b"z\r".to_vec())).unwrap();
    assert_eq!(drx.recv_timeout(WAIT).unwrap(), b"z\r");

    mgr.write(id, b"S6\r").unwrap();
    mgr.write(id, b"O\r").unwrap();
    assert_eq!(*written.lock().unwrap(), b"S6\rO\r");
}

#[test]
fn user_close_is_silent_and_releases_resources() {
    let mgr = LinkManager::new();
    let (ep, _tx, _, closed) = fake_endpoint();
    let (ctx, crx) = mpsc::channel();
    let id = mgr.attach(ep, Box::new(|_| true), Box::new(move |i, r| ctx.send((i, r)).unwrap()));

    mgr.close(id).unwrap();
    assert!(*closed.lock().unwrap());
    assert!(matches!(mgr.write(id, b"x"), Err(LinkError::UnknownLink(_))));
    assert!(matches!(mgr.close(id), Err(LinkError::UnknownLink(_))));
    // The reader thread must exit without reporting a loss.
    assert!(crx.recv_timeout(Duration::from_millis(300)).is_err());
}

#[test]
fn read_error_reports_loss_once_and_forgets_the_link() {
    let mgr = LinkManager::new();
    let (ep, tx, _, closed) = fake_endpoint();
    let (ctx, crx) = mpsc::channel();
    let id = mgr.attach(ep, Box::new(|_| true), Box::new(move |i, r| ctx.send((i, r)).unwrap()));

    tx.send(Err(io::Error::new(io::ErrorKind::BrokenPipe, "unplugged"))).unwrap();
    let (got_id, reason) = crx.recv_timeout(WAIT).unwrap();
    assert_eq!(got_id, id);
    assert!(matches!(reason, CloseReason::Error(m) if m.contains("unplugged")));
    assert!(*closed.lock().unwrap());
    assert!(matches!(mgr.write(id, b"x"), Err(LinkError::UnknownLink(_))));
}

#[test]
fn ids_are_unique_per_link() {
    let mgr = LinkManager::new();
    let (a, _ta, _, _) = fake_endpoint();
    let (b, _tb, _, _) = fake_endpoint();
    let ia = mgr.attach(a, Box::new(|_| true), Box::new(|_, _| {}));
    let ib = mgr.attach(b, Box::new(|_| true), Box::new(|_, _| {}));
    assert_ne!(ia, ib);
    mgr.close_all();
    assert!(mgr.close(ia).is_err());
}

#[test]
fn tcp_echo_roundtrip() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        let mut buf = [0u8; 64];
        loop {
            match s.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => s.write_all(&buf[..n]).unwrap(),
            }
        }
    });

    let mgr = LinkManager::new();
    let (dtx, drx) = mpsc::channel::<Vec<u8>>();
    let id = mgr
        .open_tcp("127.0.0.1", port, WAIT, Box::new(move |b| dtx.send(b.to_vec()).is_ok()), Box::new(|_, _| {}))
        .unwrap();
    mgr.write(id, b"t1238DEADBEEF\r").unwrap();

    let mut echoed = Vec::new();
    while echoed.len() < 14 {
        echoed.extend(drx.recv_timeout(WAIT).unwrap());
    }
    assert_eq!(echoed, b"t1238DEADBEEF\r");
    mgr.close(id).unwrap();
}

#[test]
fn tcp_peer_close_is_reported() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (s, _) = listener.accept().unwrap();
        drop(s);
    });

    let mgr = LinkManager::new();
    let (ctx, crx) = mpsc::channel();
    let id = mgr
        .open_tcp("127.0.0.1", port, WAIT, Box::new(|_| true), Box::new(move |i, r| ctx.send((i, r)).unwrap()))
        .unwrap();
    let (got, reason) = crx.recv_timeout(WAIT).unwrap();
    assert_eq!(got, id);
    assert_eq!(reason, CloseReason::PeerClosed);
}

#[test]
fn tcp_connect_failure_is_an_error() {
    // Bind then drop to obtain a port nobody listens on.
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let mgr = LinkManager::new();
    let r = mgr.open_tcp("127.0.0.1", port, Duration::from_millis(500), Box::new(|_| true), Box::new(|_, _| {}));
    assert!(matches!(r, Err(LinkError::Connect(_))));
}

#[test]
fn opening_a_missing_serial_port_fails_cleanly() {
    let mgr = LinkManager::new();
    let r = mgr.open_serial("/dev/cygnus-does-not-exist", 115_200, Box::new(|_| true), Box::new(|_, _| {}));
    assert!(matches!(r, Err(LinkError::Serial(_))));
}

/// Writer whose drop is observable: proves `close()` released the OS handle before returning.
struct DropFlagWriter(Arc<Mutex<bool>>);
impl Write for DropFlagWriter {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Drop for DropFlagWriter {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = true;
    }
}
struct DropFlagReader(Arc<Mutex<bool>>);
impl Read for DropFlagReader {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        thread::sleep(Duration::from_millis(5));
        Err(io::ErrorKind::TimedOut.into())
    }
}
impl Drop for DropFlagReader {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = true;
    }
}

#[test]
fn close_returns_after_every_handle_is_dropped() {
    let mgr = LinkManager::new();
    let w = Arc::new(Mutex::new(false));
    let r = Arc::new(Mutex::new(false));
    let ep = Endpoint {
        reader: Box::new(DropFlagReader(r.clone())),
        writer: Box::new(DropFlagWriter(w.clone())),
        closer: Box::new(|| {}),
    };
    let id = mgr.attach(ep, Box::new(|_| true), Box::new(|_, _| {}));
    mgr.close(id).unwrap();
    assert!(*w.lock().unwrap(), "writer still alive after close");
    assert!(*r.lock().unwrap(), "reader still alive after close");
    assert!(mgr.is_empty());
}

#[test]
fn a_gone_consumer_closes_the_link() {
    let mgr = LinkManager::new();
    let (ep, tx, _, closed) = fake_endpoint();
    let (ctx, crx) = mpsc::channel();
    let id = mgr.attach(ep, Box::new(|_| false), Box::new(move |i, r| ctx.send((i, r)).unwrap()));
    tx.send(Ok(b"x".to_vec())).unwrap();
    let (got, _) = crx.recv_timeout(WAIT).unwrap();
    assert_eq!(got, id);
    assert!(*closed.lock().unwrap());
    assert!(mgr.is_empty());
}

#[cfg(unix)]
#[test]
fn serial_port_reopens_right_after_close_and_on_reload() {
    use serialport::{SerialPort, TTYPort};
    let (_master, slave) = TTYPort::pair().expect("pty pair");
    let path = slave.name().expect("pty name");
    drop(slave);
    let mgr = LinkManager::new();
    let a = mgr.open_serial(&path, 115_200, Box::new(|_| true), Box::new(|_, _| {})).expect("first open");
    // webview reload: the page forgot `a` and opens the same path again
    let b = mgr.open_serial(&path, 115_200, Box::new(|_| true), Box::new(|_, _| {})).expect("reopen while registered");
    assert!(mgr.close(a).is_err(), "the stale link was replaced");
    mgr.close(b).unwrap();
    // reconnect race: close then open at once
    let c = mgr.open_serial(&path, 115_200, Box::new(|_| true), Box::new(|_, _| {})).expect("reopen right after close");
    mgr.close(c).unwrap();
}
