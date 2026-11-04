# ADR 0001: M0 Agent Authentication

- Status: Accepted
- Date: 2026-11-04

## Context

M0 needs one preconfigured Windows worker to authenticate over an outbound Manager–Agent WebSocket connection. The connection may cross a LAN, VPN, or reverse proxy. The Agent must initiate the connection, production traffic must use TLS, secrets must not be logged, and credential rotation must be documented. The specification leaves the choice between mutual TLS and a rotatable credential open. M0 does not include a pairing UI or persistent credential database.

## Decision

**Accepted:** use a high-entropy, per-worker shared token supplied to the Manager and Agent through protected environment configuration. Require `wss://` for production Agent configuration. Compare tokens without logging them, keep them out of URLs, and rotate by updating both configurations and restarting both services.

The M0 implementation follows this decision. Local development may use `ws://` only on the private Compose network.

## Alternatives

1. **Mutual TLS with per-worker certificates.** It provides certificate-based identity and supports individual certificate revocation. It adds certificate issuance, renewal, storage, and trust configuration across the Raspberry Pi and Windows Docker Desktop Agent.
2. **Shared per-worker token over TLS.** It is simple to provision in both environments and matches the M0 preconfigured-credential requirement. Possession of the token grants worker identity, so environment files and Manager/Agent hosts must be protected; rotation requires coordinated restarts.
3. **One-time pairing with short-lived tokens.** It provides a better enrollment and revocation lifecycle, but requires a pairing flow and durable Manager-side credential state that are outside M0.

## Consequences

- The Manager and Agent share a secret; Docker host administrators can inspect container environment configuration.
- Production secrecy depends on TLS termination being correctly configured. The Pi Compose example binds the Manager to loopback for a host reverse proxy.
- Token replacement causes a brief worker disconnect and requires both services to receive the new value.
- Multi-worker enrollment, independent revocation, mTLS, and a durable credential store remain future decisions.

## Validation and follow-up

- Completed: tests reject a wrong token and unsupported protocol messages; Agent reconnection after Manager restart is covered.
- Pending: exercise WSS through the production TLS proxy, inspect authentication-failure logs for secret redaction, and run the coordinated token-rotation procedure.
