import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempTrackedForFileSync } from "@scp/test-tmpdir";

/** Test-only throwaway certificate and revocation generation. See docs/federation.md §556. */

export function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(dir: string, args: string[]): void {
  execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
}

export interface TestCa {
  dir: string;
  caCrtFile: string;
  caKeyFile: string;
  caCrtPem: Buffer;
}

/** Creates a throwaway authority plus its database files. See docs/federation.md §557. */
export function createTestCa(): TestCa {
  const dir = mkdtempTrackedForFileSync(join(tmpdir(), "scp-mtls-pki-"));
  const caKeyFile = join(dir, "ca.key");
  const caCrtFile = join(dir, "ca.crt");
  run(dir, ["genrsa", "-out", caKeyFile, "2048"]);
  run(dir, [
    "req",
    "-x509",
    "-new",
    "-nodes",
    "-key",
    caKeyFile,
    "-sha256",
    "-days",
    "3650",
    "-out",
    caCrtFile,
    "-subj",
    "/CN=SCP Test Federation CA"
  ]);
  writeFileSync(join(dir, "index.txt"), "");
  writeFileSync(join(dir, "crlnumber"), "1000\n");
  writeFileSync(join(dir, "serial"), "01\n");
  writeFileSync(
    join(dir, "ca.cnf"),
    [
      "[ca]",
      "default_ca = CA_default",
      "[CA_default]",
      "dir = .",
      "database = index.txt",
      "new_certs_dir = .",
      "certificate = ca.crt",
      "private_key = ca.key",
      "default_md = sha256",
      "default_days = 3650",
      "default_crl_days = 30",
      "policy = policy_any",
      "serial = serial",
      "crlnumber = crlnumber",
      "[policy_any]",
      "commonName = supplied",
      "[req]",
      "distinguished_name = req_distinguished_name",
      "[req_distinguished_name]",
      ""
    ].join("\n")
  );
  return { dir, caCrtFile, caKeyFile, caCrtPem: readFileSync(caCrtFile) };
}

export interface TestLeafCert {
  certFile: string;
  keyFile: string;
  certPem: Buffer;
  keyPem: Buffer;
}

let nextSerial = 0x2000;

/** Issues a leaf certificate signed by `ca`, optionally carrying a SAN URI (the identity
 *  `federation/mtls-enforcement.ts` reads). Each call gets a fresh, distinct serial number so
 *  `revokeLeafCert` can target exactly one cert without touching the rest. */
export function issueLeafCert(ca: TestCa, opts: { name: string; sanUri?: string }): TestLeafCert {
  const keyFile = join(ca.dir, `${opts.name}.key`);
  const csrFile = join(ca.dir, `${opts.name}.csr`);
  const certFile = join(ca.dir, `${opts.name}.crt`);
  const extFile = join(ca.dir, `${opts.name}.ext`);
  run(ca.dir, ["genrsa", "-out", keyFile, "2048"]);
  run(ca.dir, ["req", "-new", "-key", keyFile, "-out", csrFile, "-subj", `/CN=${opts.name}`]);
  writeFileSync(
    extFile,
    `subjectAltName = ${opts.sanUri ? `URI:${opts.sanUri}` : "DNS:localhost"}\n`
  );
  const serial = (nextSerial++).toString(16);
  run(ca.dir, [
    "x509",
    "-req",
    "-in",
    csrFile,
    "-CA",
    ca.caCrtFile,
    "-CAkey",
    ca.caKeyFile,
    "-CAcreateserial",
    "-out",
    certFile,
    "-days",
    "3650",
    "-sha256",
    "-extfile",
    extFile,
    "-set_serial",
    `0x${serial}`
  ]);
  return { certFile, keyFile, certPem: readFileSync(certFile), keyPem: readFileSync(keyFile) };
}

/** Revokes `leaf` against `ca`'s own database (populates `index.txt` on first use — `openssl ca
 *  -revoke` doesn't require the cert to have been pre-registered there, only signed by this CA). */
export function revokeLeafCert(ca: TestCa, leaf: TestLeafCert): void {
  run(ca.dir, [
    "ca",
    "-config",
    "ca.cnf",
    "-revoke",
    leaf.certFile,
    "-keyfile",
    "ca.key",
    "-cert",
    "ca.crt",
    "-batch"
  ]);
}

/** Generates a CRL from `ca`'s database. See docs/federation.md §558. */
export function generateCrl(ca: TestCa, opts: { nextUpdate?: string } = {}): Buffer {
  const crlFile = join(ca.dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.crl`);
  const args = [
    "ca",
    "-config",
    "ca.cnf",
    "-gencrl",
    "-keyfile",
    "ca.key",
    "-cert",
    "ca.crt",
    "-out",
    crlFile,
    "-batch"
  ];
  if (opts.nextUpdate) args.push("-crl_nextupdate", opts.nextUpdate);
  run(ca.dir, args);
  return readFileSync(crlFile);
}
