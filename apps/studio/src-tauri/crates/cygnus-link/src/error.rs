use std::fmt;

#[derive(Debug)]
pub enum LinkError {
    /// No open link has this id (never opened, or already closed/lost).
    UnknownLink(u32),
    /// The operating system refused or failed an I/O operation.
    Io(String),
    /// The serial backend reported an error (enumeration, open, configuration).
    Serial(String),
    /// The address could not be resolved or the connection timed out.
    Connect(String),
}

impl fmt::Display for LinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LinkError::UnknownLink(id) => write!(f, "unknown link id {id}"),
            LinkError::Io(m) => write!(f, "I/O error: {m}"),
            LinkError::Serial(m) => write!(f, "serial error: {m}"),
            LinkError::Connect(m) => write!(f, "connect error: {m}"),
        }
    }
}

impl std::error::Error for LinkError {}

impl From<std::io::Error> for LinkError {
    fn from(e: std::io::Error) -> Self {
        LinkError::Io(e.to_string())
    }
}

impl From<serialport::Error> for LinkError {
    fn from(e: serialport::Error) -> Self {
        LinkError::Serial(e.to_string())
    }
}
