use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::error::LinkError;
use crate::manager::Endpoint;

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
