//! Byte links (serial ports and TCP sockets) for the Cygnus Studio desktop shell.
//!
//! The crate has no GUI dependency: every link owns a reader thread that pushes raw
//! chunks into a callback, so the Tauri layer (or a test) decides where the bytes go.

mod error;
mod manager;
mod serial;
mod tcp;

pub use error::LinkError;
pub use manager::{ClosedHandler, CloseReason, DataHandler, Endpoint, LinkId, LinkManager};
pub use serial::{list_serial_ports, SerialPortEntry};
