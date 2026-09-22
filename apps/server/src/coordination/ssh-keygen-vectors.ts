/**
 * REAL `ssh-keygen -y` OUTPUT, recorded once, for three PKCS#8 PEM ed25519 private keys.
 *
 * These are the second implementation that `ssh-credentials.test.ts` checks the module's
 * public-key derivation against. Frozen rather than generated at test time because generating
 * them needs an OpenSSH binary, and obtaining one in CI needs the network — which CI blackholes
 * ("tests never touch the internet", charter principle 5). An earlier version ran ssh-keygen in a
 * container and failed on integration shard 1 for exactly that reason.
 *
 * They also pin the measurement the design depends on: OpenSSH reads a PKCS#8 PEM ed25519 private
 * key directly, which is why this codebase contains no OpenSSH private-key encoder.
 *
 * THROWAWAY KEYS. Generated solely for this fixture, never used to authenticate anything.
 * Regenerate with `ssh-keygen -y -f <pkcs8.pem>` if OpenSSH's output format ever changes.
 */
export const SSH_KEYGEN_VECTORS: { privateKeyPem: string; sshKeygenPublicKey: string }[] = [
  {
    privateKeyPem:
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJcxeQa/hY5bSuCGXQ6cWhszcD9/Z2z9sSqqbhHJVNuP\n-----END PRIVATE KEY-----\n",
    sshKeygenPublicKey:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICSwjEuBHgqItZu7begnhRtU+k7sUAWz71Q3F/JVYOSb"
  },
  {
    privateKeyPem:
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIPu/NqNqm3Xj3yW70HAX28N+o5UGLzcifyZ1oDDyct9f\n-----END PRIVATE KEY-----\n",
    sshKeygenPublicKey:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILZaMojLg6WKC14MlUIUzDBdrlzK8zOPb8/vsxmortkf"
  },
  {
    privateKeyPem:
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEICWK1cAU8i/54SUbHnEWZKwKgpWpVFQGwSM2Nh6ZPCZg\n-----END PRIVATE KEY-----\n",
    sshKeygenPublicKey:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKa/zWECLEbLqOhRsJhHkx/+E2W7VyjuNtqNqdKJvKzm"
  }
];
