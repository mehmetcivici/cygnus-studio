use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::time::Duration;

use socket2::{SockRef, TcpKeepalive};

use crate::error::LinkError;
use crate::manager::Endpoint;

const READ_TIMEOUT: Duration = Duration::from_millis(20);
const WRITE_TIMEOUT: Duration = Duration::from_millis(500);
const KEEPALIVE_IDLE: Duration = Duration::from_secs(2);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(1);

pub(crate) fn connect(host: &str, port: u16, timeout: Duration) -> Result<Endpoint, LinkError> {
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| LinkError::Connect(format!("cannot resolve {host}: {e}")))?;
    let mut last = None;
    let mut stream = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(e) => last = Some(e),
        }
    }
    let stream = stream.ok_or_else(|| match last {
        Some(e) => LinkError::Connect(format!("{host}:{port}: {e}")),
        None => LinkError::Connect(format!("{host} resolved to no addresses")),
    })?;
    // CAN frames are tiny and latency-sensitive; Nagle would batch them.
    stream.set_nodelay(true)?;
    // Same polling as serial: the reader notices a user close without relying on shutdown().
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    // A half-open connection (robot power or cable pulled, no FIN) would otherwise block forever
    // and the UI would stay "connected"; keepalive probes turn it into a read error (2 s idle, then
    // 1 s probes; the OS probe count applies, ≈ 10 s on Linux).
    let ka = TcpKeepalive::new().with_time(KEEPALIVE_IDLE).with_interval(KEEPALIVE_INTERVAL);
    SockRef::from(&stream).set_tcp_keepalive(&ka)?;
    let reader = stream.try_clone()?;
    let writer = stream.try_clone()?;
    Ok(Endpoint {
        reader: Box::new(reader),
        writer: Box::new(writer),
        closer: Box::new(move || {
            let _ = stream.shutdown(Shutdown::Both);
        }),
    })
}
