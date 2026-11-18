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

fn fake_endpoint() -> (Endpoint, Sender<io::Result<Vec<u8>>>, Arc<Mutex<Vec<u8>>>, Arc<Mutex<bool>>) {
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
    let id = mgr.attach(ep, Box::new(move |b| dtx.send(b.to_vec()).unwrap()), Box::new(|_, _| {}));

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
    let id = mgr.attach(ep, Box::new(|_| {}), Box::new(move |i, r| ctx.send((i, r)).unwrap()));

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
    let id = mgr.attach(ep, Box::new(|_| {}), Box::new(move |i, r| ctx.send((i, r)).unwrap()));

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
    let ia = mgr.attach(a, Box::new(|_| {}), Box::new(|_, _| {}));
    let ib = mgr.attach(b, Box::new(|_| {}), Box::new(|_, _| {}));
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
        .open_tcp("127.0.0.1", port, WAIT, Box::new(move |b| dtx.send(b.to_vec()).unwrap()), Box::new(|_, _| {}))
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
        .open_tcp("127.0.0.1", port, WAIT, Box::new(|_| {}), Box::new(move |i, r| ctx.send((i, r)).unwrap()))
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
    let r = mgr.open_tcp("127.0.0.1", port, Duration::from_millis(500), Box::new(|_| {}), Box::new(|_, _| {}));
    assert!(matches!(r, Err(LinkError::Connect(_))));
}

#[test]
fn opening_a_missing_serial_port_fails_cleanly() {
    let mgr = LinkManager::new();
    let r = mgr.open_serial("/dev/cygnus-does-not-exist", 115_200, Box::new(|_| {}), Box::new(|_, _| {}));
    assert!(matches!(r, Err(LinkError::Serial(_))));
}
