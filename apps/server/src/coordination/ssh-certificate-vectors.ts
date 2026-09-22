/**
 * A DETERMINISTIC certificate this module produced, validated once against real OpenSSH.
 *
 * ed25519 signing is deterministic and the nonce is injectable, so identical inputs yield
 * identical bytes — which makes a frozen expected value a real cross-implementation check rather
 * than a tautology. Recorded offline for the same reason as ssh-keygen-vectors.ts: obtaining an
 * OpenSSH binary in CI needs the network, and CI blackholes egress.
 *
 * VALIDATED, NOT JUST PARSED. Beyond `ssh-keygen -L` reading every field back correctly, a real
 * `sshd` with this CA in TrustedUserCAKeys AUTHENTICATED a session using a certificate from this
 * code path:
 *
 *   Accepted publickey for scp-ops from 127.0.0.1 ssh2: ED25519-CERT SHA256:...
 *     ID scp-run-abc123 (serial 4242) CA ED25519 SHA256:...
 *
 * That log line also confirms ADR-0051 D5 is implementable against stock sshd: the SERIAL appears
 * in ordinary `Accepted publickey` output, so forgery reconciliation needs no special logging.
 *
 * THROWAWAY KEY, generated solely for this fixture.
 */
export const FROZEN_CERTIFICATE_VECTOR = {
  caPrivateKeyPem:
    "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIMx7vJ0Qm3T8nJ0kV5Rr8Yx3Z2p1qLw9sF4dH6tB2cJk\n-----END PRIVATE KEY-----\n",
  userPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICSwjEuBHgqItZu7begnhRtU+k7sUAWz71Q3F/JVYOSb",
  cert: "ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHAAAAICSwjEuBHgqItZu7begnhRtU+k7sUAWz71Q3F/JVYOSbAAAAAAAAEJIAAAABAAAAFXNjcC1ydW4tZnJvemVuLXZlY3RvcgAAAAsAAAAHc2NwLW9wcwAAAABpVbkAAAAAAHwkXwAAAAAkAAAADnNvdXJjZS1hZGRyZXNzAAAADgAAAAoxMC4wLjAuMC84AAAAAAAAAAAAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIPKVOsL3oNVrkSb/1sZ2fFzSNx/JbV8ngw7hcXqzcJG9AAAAUwAAAAtzc2gtZWQyNTUxOQAAAEAzf9ZxLLtCKIFA6YZhNEBqeFKsvbeeN4VfJl6cVJ0yBZYc7fGrNNPFVdqvnoD2KojfJbC7mdmdOumG+0xsO0QK"
} as const;
