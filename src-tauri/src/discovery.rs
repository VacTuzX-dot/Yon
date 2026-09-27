//! LAN discovery over mDNS/DNS-SD (`_yon._tcp`).
//!
//! Everything in an advert is unauthenticated. The `id` is only used to pin
//! the TLS key when connecting; `name` is display-only and spoofable.

use crate::identity::{parse_fingerprint, short_fingerprint, Fingerprint};
use crate::protocol::{MAX_DEVICE_NAME_BYTES, PROTOCOL_VERSION};
use mdns_sd::{IfKind, ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Mutex;

pub const SERVICE_TYPE: &str = "_yon._tcp.local.";

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Device {
    /// Full fingerprint hex; also the device key used by the UI.
    pub id: String,
    pub name: String,
    pub os: String,
    pub app: String,
    pub compatible: bool,
    pub short_fingerprint: String,
    #[serde(skip)]
    /// Candidate addresses, best first (see [`rank`]). Tried in order.
    pub addrs: Vec<SocketAddrV4>,
    #[serde(skip)]
    pub fingerprint: Fingerprint,
}

pub struct Discovery {
    daemon: ServiceDaemon,
    my_id: String,
    registered: Mutex<Option<String>>,
}

impl Discovery {
    pub fn start(my_id: String) -> Result<Self, mdns_sd::Error> {
        let daemon = ServiceDaemon::new()?;
        // Phase 1 is IPv4-only.
        daemon.disable_interface(IfKind::IPv6)?;
        Ok(Self {
            daemon,
            my_id,
            registered: Mutex::new(None),
        })
    }

    /// (Re-)advertise this device. Call again after a name or port change.
    pub fn advertise(&self, name: &str, port: u16) -> Result<(), mdns_sd::Error> {
        let short = &self.my_id[..16];
        let props = [
            ("v", PROTOCOL_VERSION.to_string()),
            ("id", self.my_id.clone()),
            ("name", clean_name(name)),
            ("os", crate::platform::os_name().to_string()),
            ("app", env!("CARGO_PKG_VERSION").to_string()),
        ];
        let info = ServiceInfo::new(
            SERVICE_TYPE,
            &format!("yon-{short}"),
            &format!("yon-{short}.local."),
            "",
            port,
            &props[..],
        )?
        .enable_addr_auto();
        let mut reg = self.registered.lock().expect("lock");
        if let Some(old) = reg.take() {
            let _ = self.daemon.unregister(&old);
        }
        *reg = Some(info.get_fullname().to_string());
        self.daemon.register(info)
    }

    /// Spawn a thread that keeps the device list current and hands every
    /// new snapshot to `on_change`.
    pub fn browse(
        &self,
        on_change: impl Fn(Vec<Device>) + Send + 'static,
    ) -> Result<(), mdns_sd::Error> {
        let events = self.daemon.browse(SERVICE_TYPE)?;
        let my_id = self.my_id.clone();
        std::thread::Builder::new()
            .name("yon-discovery".into())
            .spawn(move || {
                let mut devices: HashMap<String, Device> = HashMap::new();
                while let Ok(event) = events.recv() {
                    let changed = match event {
                        ServiceEvent::ServiceResolved(svc) => {
                            let props = |k: &str| svc.get_property_val_str(k).map(str::to_string);
                            let addrs: Vec<Ipv4Addr> = svc.get_addresses_v4().into_iter().collect();
                            match device_from(&props, &addrs, svc.get_port()) {
                                Some(d) if d.id != my_id => {
                                    devices.insert(svc.get_fullname().to_string(), d);
                                    true
                                }
                                _ => false,
                            }
                        }
                        ServiceEvent::ServiceRemoved(_, fullname) => {
                            devices.remove(&fullname).is_some()
                        }
                        _ => false,
                    };
                    if changed {
                        let mut list: Vec<Device> = devices.values().cloned().collect();
                        list.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
                        on_change(list);
                    }
                }
            })
            .map(|_| ())
            .map_err(|e| mdns_sd::Error::Msg(e.to_string()))
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        let _ = self.daemon.shutdown();
    }
}

/// Build a device from an untrusted advert. Returns `None` if it's unusable.
pub fn device_from(
    props: &dyn Fn(&str) -> Option<String>,
    addrs: &[Ipv4Addr],
    port: u16,
) -> Option<Device> {
    let id = props("id")?.to_ascii_lowercase();
    let get = |k: &str| props(k).unwrap_or_default();
    let fingerprint = parse_fingerprint(&id)?;
    // Only addresses we'd accept connections from ourselves; a device can
    // advertise several (Wi-Fi + Ethernet + VPN + Docker…), so keep a few
    // candidates in a stable order and let the sender try them in turn.
    let mut ips: Vec<Ipv4Addr> = addrs
        .iter()
        .copied()
        .filter(|ip| crate::server::is_allowed_peer(&SocketAddr::from((*ip, port))))
        .collect();
    ips.sort_by_key(|ip| (rank(ip), *ip));
    ips.dedup();
    ips.truncate(MAX_CANDIDATES);
    if ips.is_empty() {
        return None;
    }
    let v = props("v").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
    Some(Device {
        short_fingerprint: short_fingerprint(&fingerprint),
        name: clean_name(&get("name")),
        os: clean(&get("os"), 16),
        app: clean(&get("app"), 16),
        compatible: v == PROTOCOL_VERSION,
        addrs: ips
            .into_iter()
            .map(|ip| SocketAddrV4::new(ip, port))
            .collect(),
        fingerprint,
        id,
    })
}

const MAX_CANDIDATES: usize = 4;

/// Lower = tried first. Home/office LANs are usually 192.168/16; 10/8 is
/// common for both LANs and VPNs; 172.16/12 is mostly Docker/VM bridges;
/// link-local and loopback are last resorts.
fn rank(ip: &Ipv4Addr) -> u8 {
    match ip.octets() {
        [192, 168, ..] => 0,
        [10, ..] => 1,
        [172, b, ..] if (16..32).contains(&b) => 2,
        [169, 254, ..] => 3,
        _ => 4, // loopback
    }
}

fn clean_name(s: &str) -> String {
    let n = clean(s, MAX_DEVICE_NAME_BYTES);
    if n.is_empty() {
        "Unknown device".into()
    } else {
        n
    }
}

fn clean(s: &str, max: usize) -> String {
    crate::sanitize::clean_display(s, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "a1b2c3d4e5f60718000000000000000000000000000000000000000000000000";

    fn props<'a>(m: &'a HashMap<&'a str, &'a str>) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| m.get(k).map(|v| v.to_string())
    }

    #[test]
    fn parses_valid_advert() {
        let m = HashMap::from([
            ("v", "1"),
            ("id", ID),
            ("name", "Leo's Mac"),
            ("os", "macos"),
        ]);
        let d = device_from(&props(&m), &[Ipv4Addr::new(192, 168, 1, 9)], 53420).unwrap();
        assert!(d.compatible);
        assert_eq!(d.name, "Leo's Mac");
        assert_eq!(d.short_fingerprint, "A1B2-C3D4-E5F6-0718");
        assert_eq!(d.addrs, vec!["192.168.1.9:53420".parse().unwrap()]);
    }

    #[test]
    fn marks_other_versions_incompatible() {
        let m = HashMap::from([("v", "2"), ("id", ID)]);
        let d = device_from(&props(&m), &[Ipv4Addr::new(10, 0, 0, 2)], 1).unwrap();
        assert!(!d.compatible);
        let m = HashMap::from([("id", ID)]);
        assert!(
            !device_from(&props(&m), &[Ipv4Addr::new(10, 0, 0, 2)], 1)
                .unwrap()
                .compatible
        );
    }

    #[test]
    fn rejects_bad_id_or_public_only_address() {
        let bad = HashMap::from([("v", "1"), ("id", "nothex")]);
        assert!(device_from(&props(&bad), &[Ipv4Addr::new(10, 0, 0, 2)], 1).is_none());
        let good = HashMap::from([("v", "1"), ("id", ID)]);
        assert!(device_from(&props(&good), &[Ipv4Addr::new(8, 8, 8, 8)], 1).is_none());
        assert!(device_from(&props(&good), &[], 1).is_none());
    }

    #[test]
    fn prefers_lan_over_loopback_and_cleans_name() {
        let m = HashMap::from([("v", "1"), ("id", ID), ("name", "\u{1b}[31mEvil\n")]);
        let addrs = [Ipv4Addr::LOCALHOST, Ipv4Addr::new(192, 168, 0, 7)];
        let d = device_from(&props(&m), &addrs, 1).unwrap();
        assert_eq!(*d.addrs[0].ip(), Ipv4Addr::new(192, 168, 0, 7));
        assert_eq!(d.name, "[31mEvil");
    }

    #[test]
    fn orders_multiple_interfaces_deterministically() {
        let m = HashMap::from([("v", "1"), ("id", ID)]);
        let addrs = [
            Ipv4Addr::LOCALHOST,
            Ipv4Addr::new(172, 17, 0, 1),   // docker bridge
            Ipv4Addr::new(8, 8, 8, 8),      // public: never a candidate
            Ipv4Addr::new(10, 8, 0, 2),     // VPN
            Ipv4Addr::new(192, 168, 1, 20), // Wi-Fi
            Ipv4Addr::new(192, 168, 1, 5),  // Ethernet
            Ipv4Addr::new(192, 168, 1, 5),  // duplicate
        ];
        let d = device_from(&props(&m), &addrs, 7).unwrap();
        let got: Vec<String> = d.addrs.iter().map(|a| a.to_string()).collect();
        assert_eq!(
            got,
            [
                "192.168.1.5:7",
                "192.168.1.20:7",
                "10.8.0.2:7",
                "172.17.0.1:7"
            ]
        );
    }
}
