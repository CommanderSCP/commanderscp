# =============================================================================================
# THE TEST HOST (M27.9 item d) — a real `sshd` that trusts an SCP-minted CA.
#
# TEST-ONLY, and deliberately NOT under `apps/runner-*`: `@scp/airgap` requires every directory
# matching that pattern to be carried by the air-gap bundle and activatable by an env var the
# server reads. This image must never ship — it exists so the end-to-end path can be exercised
# against a real OpenSSH server rather than against a mock that agrees with us.
#
# WHY THIS EXISTS AT ALL. M27 proved certificate SIGNING against frozen `ssh-keygen` vectors,
# which is the right test for the wire format and answers nothing about whether `sshd` will
# ACCEPT what we sign. Those are different claims: a certificate can be byte-correct under our own
# parser and be rejected by OpenSSH for a principal mismatch, a validity interval, a missing
# extension, or a signature over the wrong region. Only a real `sshd` settles it — and the first
# run of this fixture found FOUR defects that every prior M27 test had passed over.
#
# DEBIAN 12, NOT ALPINE, and that is a finding rather than a preference. The first draft was Alpine;
# the play then failed with "Could not find a matching action for the apk package manager",
# because the lockdown allowlist (ADR-0050) admits `apt`/`dnf` and correctly does NOT admit `apk`
# — the charter's three classes were derived for the apt and dnf families. An Alpine test host
# would have been testing a platform the product does not claim to support.
#
# The CA public key is supplied at RUN time (`SCP_TEST_CA_PUBKEY`), never baked in: the test mints
# a fresh per-domain CA, which is the whole point of ADR-0051 D2.
# =============================================================================================
FROM debian:12

# `openssh-sftp-server` is NOT optional and was missed first time round: Ansible ships each module
# to the target before running it, over sftp with scp as a fallback. With neither present the run
# AUTHENTICATES SUCCESSFULLY and then fails with a transfer error, which reads like a credential
# problem and is not one.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server openssh-sftp-server python3 cron && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /run/sshd

# `root` IS the principal (ADR-0051 D4 as amended 2026-09-23) — the certificate authorizes root
# directly and there is no sudo step, so the account must be able to log in by public key.
# `prohibit-password` and not `yes`: password auth stays off, so the certificate is the ONLY way in
# and a test that passes cannot be passing for some other reason.
#
# `LogLevel VERBOSE` is load-bearing rather than diagnostic: it is what makes sshd log the
# certificate SERIAL and key id on each authentication, which is the host-side half of ADR-0051
# D5's reconciliation. A test that could not read a serial off the host could not show the
# detective control closes.
RUN printf '%s\n' \
      'PermitRootLogin prohibit-password' \
      'PubkeyAuthentication yes' \
      'PasswordAuthentication no' \
      'KbdInteractiveAuthentication no' \
      'TrustedUserCAKeys /etc/ssh/scp-trusted-user-ca.pub' \
      'LogLevel VERBOSE' \
      > /etc/ssh/sshd_config.d/00-scp.conf

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
