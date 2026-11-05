//! Cross-session peer store: remember peers we have met so a restart does not
//! depend on a bootstrap node being reachable.
//!
//! Without this, every start has to reach a bootstrap peer to find anyone —
//! which makes bootstrap infrastructure a hard single point of failure. Standard
//! DHT practice is to persist the routing table across sessions so bootstrap is
//! only needed on a node's very first run; see the libtorrent DHT bootstrap
//! notes. With no public Rotifer network deployed yet, this is what lets a
//! self-organised group of nodes re-form after a restart with no bootstrap at
//! all.
//!
//! Entries are full multiaddrs including the `/p2p/<peer-id>` suffix, i.e. the
//! same shape as `--bootstrap` arguments, so they can be dialled directly.

use std::path::{Path, PathBuf};

/// Upper bound on persisted entries. Keeps the file small and bounded; a
/// handful of reachable peers is all that is needed to re-enter a network.
pub const MAX_PERSISTED_PEERS: usize = 64;

/// Default peer-store path: `$HOME/.rotifer/peers.json` — alongside the node
/// identity, so a node's state lives in one place.
pub fn default_peerstore_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".rotifer").join("peers.json")
}

/// Load remembered peer multiaddrs.
///
/// Deliberately total: a missing, unreadable, or corrupt store yields an empty
/// list rather than an error. A damaged cache must never stop a node from
/// starting — the worst case is falling back to bootstrap, which is exactly the
/// pre-existing behaviour.
pub fn load(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(addrs) = serde_json::from_str::<Vec<String>>(&text) else {
        tracing::debug!("peer store at {} is unreadable; ignoring", path.display());
        return Vec::new();
    };
    normalise(addrs)
}

/// Serialize peer multiaddrs for persistence: deduplicated, capped, order
/// preserved. Split out from [`save`] so the policy is unit-testable without
/// touching the filesystem.
pub fn encode(addrs: &[String]) -> String {
    let kept = normalise(addrs.to_vec());
    serde_json::to_string_pretty(&kept).unwrap_or_else(|_| "[]".to_string())
}

/// Where the dialled-OK level lives: beside the plain store, which keeps its
/// list-of-addresses format (the heard-of level, readable by older
/// versions). `peers.json` → `peers-dialed.json`.
///
/// A store written before this file existed has no dialled-OK entries: all
/// its addresses count as heard-of, so neither top-up nor a restart dials
/// them (A6 design v3 §1.6).
pub fn dialed_path(peers: &Path) -> PathBuf {
    let stem = peers.file_stem().and_then(|s| s.to_str()).unwrap_or("peers");
    peers.with_file_name(format!("{stem}-dialed.json"))
}

/// Load the dialled-OK entries. Total like [`load`]: a missing or damaged
/// file yields none.
pub fn load_dialed(path: &Path) -> Vec<super::outbound::DialedEntry> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_else(|_| {
        tracing::debug!("dialled-OK peer store at {} is unreadable; ignoring", path.display());
        Vec::new()
    })
}

/// Serialize dialled-OK entries, capped at [`MAX_PERSISTED_PEERS`].
pub fn encode_dialed(entries: &[super::outbound::DialedEntry]) -> String {
    let kept: Vec<_> = entries.iter().take(MAX_PERSISTED_PEERS).collect();
    serde_json::to_string_pretty(&kept).unwrap_or_else(|_| "[]".to_string())
}

/// Deduplicate (first occurrence wins) and cap to [`MAX_PERSISTED_PEERS`].
fn normalise(addrs: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    addrs
        .into_iter()
        .filter(|a| !a.is_empty() && seen.insert(a.clone()))
        .take(MAX_PERSISTED_PEERS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_missing_file_yields_empty() {
        let path = std::env::temp_dir().join("rotifer-peerstore-absent-xyz.json");
        let _ = std::fs::remove_file(&path);
        assert!(load(&path).is_empty());
    }

    #[test]
    fn load_corrupt_file_yields_empty_rather_than_failing() {
        // A damaged cache must degrade to "no remembered peers", never block start.
        let path = std::env::temp_dir().join("rotifer-peerstore-corrupt.json");
        std::fs::write(&path, b"{ this is not json").unwrap();
        assert!(load(&path).is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn encode_deduplicates_preserving_first_occurrence_order() {
        let addrs = vec![
            "/ip4/10.0.0.1/tcp/9878/p2p/A".to_string(),
            "/ip4/10.0.0.2/tcp/9878/p2p/B".to_string(),
            "/ip4/10.0.0.1/tcp/9878/p2p/A".to_string(),
        ];
        let decoded: Vec<String> = serde_json::from_str(&encode(&addrs)).unwrap();
        assert_eq!(
            decoded,
            vec![
                "/ip4/10.0.0.1/tcp/9878/p2p/A".to_string(),
                "/ip4/10.0.0.2/tcp/9878/p2p/B".to_string(),
            ]
        );
    }

    #[test]
    fn encode_caps_at_max_persisted_peers() {
        let addrs: Vec<String> = (0..MAX_PERSISTED_PEERS + 25)
            .map(|i| format!("/ip4/10.0.0.1/tcp/{}/p2p/P{i}", 9000 + i))
            .collect();
        let decoded: Vec<String> = serde_json::from_str(&encode(&addrs)).unwrap();
        assert_eq!(decoded.len(), MAX_PERSISTED_PEERS);
    }

    #[test]
    fn encode_drops_empty_entries() {
        let addrs = vec![String::new(), "/ip4/10.0.0.1/tcp/9878/p2p/A".to_string()];
        let decoded: Vec<String> = serde_json::from_str(&encode(&addrs)).unwrap();
        assert_eq!(decoded, vec!["/ip4/10.0.0.1/tcp/9878/p2p/A".to_string()]);
    }

    #[test]
    fn round_trip_through_a_file() {
        let path = std::env::temp_dir().join("rotifer-peerstore-roundtrip.json");
        let addrs = vec!["/ip4/192.168.1.5/tcp/9878/p2p/Alice".to_string()];
        std::fs::write(&path, encode(&addrs)).unwrap();
        assert_eq!(load(&path), addrs);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn dialed_level_sits_beside_the_plain_store_and_round_trips() {
        use super::super::outbound::DialedEntry;
        let dir = tempfile::tempdir().unwrap();
        let peers = dir.path().join("peers.json");
        assert_eq!(dialed_path(&peers), dir.path().join("peers-dialed.json"));
        // An old store with no dialled-OK file: nothing is dialled-OK.
        std::fs::write(&peers, encode(&["/ip4/10.0.0.1/tcp/1/p2p/A".to_string()])).unwrap();
        assert!(load_dialed(&dialed_path(&peers)).is_empty());
        let entries = vec![DialedEntry { addr: "/ip4/10.0.0.1/tcp/1/p2p/A".into(), last_ok_ms: 42 }];
        std::fs::write(dialed_path(&peers), encode_dialed(&entries)).unwrap();
        assert_eq!(load_dialed(&dialed_path(&peers)), entries);
        // The plain store still reads as before.
        assert_eq!(load(&peers), vec!["/ip4/10.0.0.1/tcp/1/p2p/A".to_string()]);
        std::fs::write(dialed_path(&peers), b"not json").unwrap();
        assert!(load_dialed(&dialed_path(&peers)).is_empty());
    }
}
