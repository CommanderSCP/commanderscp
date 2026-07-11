# mTLS test fixtures (M8 hardening — federation-https client certificate)

TEST-ONLY, self-signed material used exclusively by
`plugin-host/federation-mtls.integration.test.ts` to prove the `federation-https` subprocess
actually presents a client certificate (`subprocess-entry.ts`'s `loadFederationMtlsMaterial` +
`scopedFetchHttpClient`'s undici `Agent`) and that a peer without a valid one is rejected. Never
used by, or reachable from, any production code path.

Generated once (100-year expiry purely to avoid the fixture ever going stale and breaking CI —
these back a throwaway loopback TLS handshake in a test, nothing else):

```
openssl genrsa -out ca.key 2048
openssl req -x509 -new -nodes -key ca.key -sha256 -days 36500 -out ca.crt -subj "/CN=SCP Test Federation CA"

openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr -subj "/CN=localhost"
# server-ext.cnf: subjectAltName = DNS:localhost,IP:127.0.0.1
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 36500 -sha256 -extfile server-ext.cnf

openssl genrsa -out client-good.key 2048
openssl req -new -key client-good.key -out client-good.csr -subj "/CN=child-domain-test"
openssl x509 -req -in client-good.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client-good.crt -days 36500 -sha256

openssl genrsa -out client-bad.key 2048
openssl req -x509 -new -nodes -key client-bad.key -sha256 -days 36500 -out client-bad.crt -subj "/CN=untrusted-attacker"
```

- `ca.crt` — the trust root the test HTTPS server's `ca` option is configured with.
- `server.crt`/`server.key` — the test HTTPS server's own identity (signed by `ca.crt`).
- `client-good.crt`/`client-good.key` — signed by `ca.crt`; a `federation-https` instance
  configured with this pair is accepted.
- `client-bad.crt`/`client-bad.key` — self-signed, NOT signed by `ca.crt`; presenting this pair
  (or no certificate at all) must be rejected by the test server's `rejectUnauthorized: true`.
