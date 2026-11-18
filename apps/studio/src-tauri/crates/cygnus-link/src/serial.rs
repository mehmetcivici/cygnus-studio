use std::time::Duration;

use serde::Serialize;
use serialport::SerialPortType;

use crate::error::LinkError;
use crate::manager::Endpoint;

/// Short enough that a user-initiated close is noticed quickly, long enough to avoid spinning.
const READ_TIMEOUT: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortEntry {
    pub path: String,
    /// "usb", "pci", "bluetooth" or "unknown".
    pub kind: &'static str,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
}

pub fn list_serial_ports() -> Result<Vec<SerialPortEntry>, LinkError> {
    let mut entries: Vec<SerialPortEntry> = serialport::available_ports()?
        .into_iter()
        .map(|p| {
            let mut e = SerialPortEntry {
                path: p.port_name,
                kind: "unknown",
                vid: None,
                pid: None,
                manufacturer: None,
                product: None,
                serial_number: None,
            };
            match p.port_type {
                SerialPortType::UsbPort(u) => {
                    e.kind = "usb";
                    e.vid = Some(u.vid);
                    e.pid = Some(u.pid);
                    e.manufacturer = u.manufacturer;
                    e.product = u.product;
                    e.serial_number = u.serial_number;
                }
                SerialPortType::PciPort => e.kind = "pci",
                SerialPortType::BluetoothPort => e.kind = "bluetooth",
                SerialPortType::Unknown => {}
            }
            e
        })
        .collect();
    // USB adapters first: they are what the user is looking for.
    entries.sort_by(|a, b| (a.kind != "usb", &a.path).cmp(&(b.kind != "usb", &b.path)));
    Ok(entries)
}

pub(crate) fn open(path: &str, baud: u32) -> Result<Endpoint, LinkError> {
    let mut port = serialport::new(path, baud).timeout(READ_TIMEOUT).open()?;
    // Native-USB slcan firmwares (CDC) often wait for DTR before they start talking.
    let _ = port.write_data_terminal_ready(true);
    let writer = port.try_clone()?;
    Ok(Endpoint {
        reader: Box::new(port),
        writer: Box::new(writer),
        // The reader thread polls its stop flag every READ_TIMEOUT; dropping the last
        // handle (the writer, when the link is removed) releases the device.
        closer: Box::new(|| {}),
    })
}
