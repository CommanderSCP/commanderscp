#!/bin/sh
# Install the CA the test just minted, then run sshd in the foreground.
#
# FAIL-CLOSED on a missing key. Starting sshd without a trust anchor would produce a container that
# accepts connections and rejects every certificate — which reads in a test log as "the certificate
# was wrong", the one conclusion that would be false.
set -eu

if [ -z "${SCP_TEST_CA_PUBKEY:-}" ]; then
  echo "sshd-fixture: SCP_TEST_CA_PUBKEY is unset. Refusing to start: an sshd with no trust" >&2
  echo "anchor rejects every certificate, which is indistinguishable from a bad certificate." >&2
  exit 1
fi

printf '%s\n' "$SCP_TEST_CA_PUBKEY" > /etc/ssh/scp-trusted-user-ca.pub
chmod 0644 /etc/ssh/scp-trusted-user-ca.pub

# Host keys are generated at RUN time, not baked into the image: a fixture whose host key is a
# published constant would make any known_hosts test vacuous.
ssh-keygen -A >/dev/null

# `-e` sends the log to stderr, which is what `docker logs` and Testcontainers capture — the test
# reads the certificate serial back out of it.
exec /usr/sbin/sshd -D -e
