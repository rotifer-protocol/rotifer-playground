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
}
