/**
 * THE ONE FILE A HOST NEEDS (M27.8, ADR-0051 D4 as amended 2026-09-23).
 *
 * D4 accepts a standing host footprint and justifies it rather than engineering it away. This
 * module is that justification made concrete: enrolling a host is **one static file** plus an
 * `sshd_config` line. No daemon, no scheduled callback, no listener beyond the `sshd` already
 * running, no SCP code resident on the host. The host initiates nothing and, between runs, is
 * doing nothing.
 *
 * IT USED TO BE TWO. The second was a restricted sudoers fragment naming the catalog's commands,
 * and wiring enrolment up showed it could not work: Ansible's `become` never invokes `apt-get`,
 * `dnf` or `systemctl`. It invokes
 *
 *     sudo -H -S -n -u root /bin/sh -c 'echo BECOME-SUCCESS-... ; /usr/bin/python3 .../AnsiballZ_*.py'
 *
 * — a shell, running a module the connecting account itself wrote into its own `~/.ansible/tmp`.
 * A host enrolled with the generated fragment would fail every privileged task, and the fragment
 * that WOULD work is unrestricted root wearing a restriction's clothes. The owner's call
 * (2026-09-23) was to delete the control rather than keep a version of it that only reads as one:
 * the certificate's principal is now `root` (see `OPS_PRINCIPAL`), stated plainly.
 *
 * What bounds a run is therefore entirely elsewhere, and none of it moved: the signed closed
 * catalog (M27.3), the modules deleted from the image (M27.1/ADR-0050), parameters that cannot be
 * evaluated as Jinja2 (M27.2), a minutes-TTL per-run certificate, and the per-run egress allowlist
 * (M27.6b). Deleting `sudoersFragment` removes a false statement about the security posture; it
 * removes no security.
 */

export class EnrolmentGenerationError extends Error {}

/**
 * `TrustedUserCAKeys` content: the CA public key hosts trust for USER certificates.
 *
 * ONE KEY PER LINE and nothing else. The file is a trust anchor; a stray comment or a second key
 * is a second authority nobody decided to trust.
 */
export function trustedUserCaKeysFile(caPublicKey: string): string {
  const key = caPublicKey.trim();
  if (!key.startsWith("ssh-ed25519 ")) {
    throw new EnrolmentGenerationError(
      "refusing to emit TrustedUserCAKeys: the CA public key is not an ssh-ed25519 key"
    );
  }
  if (key.includes("\n")) {
    throw new EnrolmentGenerationError(
      "refusing to emit TrustedUserCAKeys: the CA public key spans multiple lines, which would " +
        "install more than one trust anchor"
    );
  }
  return `${key}\n`;
}
