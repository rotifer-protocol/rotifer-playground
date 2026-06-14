//! Exploratory spike (test-only): can two distinct-identity libp2p nodes
//! connect over loopback in-process and discover each other via Kademlia?
//!
//! This de-risks the multi-node integration harness: the `#[ignore]`d two-node
//! tests (mDNS / Kademlia / GossipSub mesh) all need several real nodes wired up
//! inside one test process. mDNS relies on multicast, which loopback does not
//! carry, so this spike uses an explicit dial + Kademlia `add_address` for a
//! deterministic result.
//!
//! Run explicitly:
//!   cargo test -p rotifer-core --lib p2p::spike -- --ignored --nocapture

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use libp2p::futures::StreamExt;
    use libp2p::kad::{self, store::MemoryStore};
    use libp2p::swarm::SwarmEvent;
    use libp2p::{Multiaddr, Swarm};

    /// Build a Swarm with TCP (Noise/Yamux) + a Kademlia behaviour in server
    /// mode and a fresh random identity.
    fn build_node() -> Swarm<kad::Behaviour<MemoryStore>> {
        libp2p::SwarmBuilder::with_new_identity()
            .with_tokio()
            .with_tcp(
                libp2p::tcp::Config::default(),
                libp2p::noise::Config::new,
                libp2p::yamux::Config::default,
            )
            .expect("tcp transport")
            .with_behaviour(|key| {
                let peer_id = key.public().to_peer_id();
                let mut kad = kad::Behaviour::new(peer_id, MemoryStore::new(peer_id));
                kad.set_mode(Some(kad::Mode::Server));
                kad
            })
            .expect("kad behaviour is infallible")
            .build()
    }

    #[tokio::test]
    #[cfg_attr(not(feature = "p2p-integration"), ignore = "spike: explicit two-node loopback connect + kad discovery — enable the p2p-integration feature or run with --ignored")]
    async fn spike_two_nodes_connect_and_discover() {
        let mut a = build_node();
        let mut b = build_node();
        let a_peer = *a.local_peer_id();
        let b_peer = *b.local_peer_id();
        println!("[spike] node A = {a_peer}");
        println!("[spike] node B = {b_peer}");

        // A listens on loopback, OS-assigned port.
        a.listen_on("/ip4/127.0.0.1/tcp/0".parse::<Multiaddr>().unwrap())
            .expect("A listen");
        let a_addr: Multiaddr = loop {
            if let SwarmEvent::NewListenAddr { address, .. } = a.select_next_some().await {
                break address;
            }
        };
        println!("[spike] node A listening at {a_addr}");

        // B dials A by address only (learns A's PeerId from the Noise handshake).
        b.dial(a_addr.clone()).expect("B dial A");

        let mut connected = false;
        let mut discovered = false;
        let outcome = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                tokio::select! {
                    ev = a.select_next_some() => {
                        if let SwarmEvent::ConnectionEstablished { peer_id, .. } = ev {
                            println!("[spike] A <- inbound connection from {peer_id}");
                        }
                    }
                    ev = b.select_next_some() => {
                        if let SwarmEvent::ConnectionEstablished { peer_id, .. } = ev {
                            connected = true;
                            b.behaviour_mut().add_address(&peer_id, a_addr.clone());
                            println!("[spike] B -> connected to {peer_id}, added to Kademlia");
                        }
                    }
                }
                if connected {
                    let entries: usize =
                        b.behaviour_mut().kbuckets().map(|kb| kb.num_entries()).sum();
                    if entries > 0 {
                        discovered = true;
                        println!("[spike] B Kademlia routing table now holds {entries} peer(s)");
                        break;
                    }
                }
            }
        })
        .await;

        assert!(
            outcome.is_ok(),
            "spike timed out (connected={connected}, discovered={discovered})"
        );
        assert!(connected, "B must establish a connection to A over loopback");
        assert!(discovered, "A must appear in B's Kademlia routing table");
        println!("[spike] SUCCESS: two distinct-identity nodes connected + discovered via Kademlia");
    }
}
