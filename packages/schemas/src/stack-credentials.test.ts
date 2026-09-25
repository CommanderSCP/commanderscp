import { describe, expect, it } from "vitest";
import {
  PutStackCredentialRequestSchema,
  PutStackCredentialSealingKeyRequestSchema,
  STACK_CREDENTIAL_CATALOG,
  STACK_CREDENTIAL_MAX_BYTES,
  StackWorkloadIdentityBindingSchema,
  catalogTargets,
  isCatalogTarget
} from "./stack-credentials.js";

/** M29.5 (ADR-0062): the credential catalog and its schemas. */

describe("the credential catalog", () => {
  it("is fixed pairs, and a pair outside it is not a target even when both names are known", () => {
    expect(catalogTargets().length).toBeGreaterThan(20);
    expect(isCatalogTarget("argo-workflows", "scp-build-registry", "registryPassword")).toBe(true);
    expect(isCatalogTarget("argo-workflows", "scp-build-registry", "AWS_ACCESS_KEY_ID")).toBe(
      false
    );
    expect(
      isCatalogTarget("argo-workflows", "scp-infra-plan-credentials", "AWS_ACCESS_KEY_ID")
    ).toBe(true);
    expect(isCatalogTarget("gitea", "scp-build-registry", "registryPassword")).toBe(false);
    // Prototype names are not keys.
    expect(isCatalogTarget("argo-workflows", "scp-build-registry", "constructor")).toBe(false);
    expect(isCatalogTarget("argo-workflows", "__proto__", "x")).toBe(false);
  });

  it("no infra key can become an environment variable that changes what the pod runs", () => {
    // Every key of an infra Secret is mounted as an env var of a pod running a repository's code.
    const dangerous =
      /^(LD_|PATH$|HOME$|SHELL$|TF_CLI_CONFIG_FILE$|TF_PLUGIN_CACHE_DIR$|TF_DATA_DIR$|NODE_OPTIONS$|GIT_|SSL_CERT|HTTPS?_PROXY$|NO_PROXY$|KUBECONFIG$)/;
    for (const secret of ["scp-infra-plan-credentials", "scp-infra-apply-credentials"] as const) {
      for (const key of Object.keys(STACK_CREDENTIAL_CATALOG["argo-workflows"][secret].keys)) {
        expect(key, `${secret}/${key}`).not.toMatch(dangerous);
        expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  it("a value is non-empty, bounded and NUL-free; the body is strict", () => {
    const ok = (v: unknown) => PutStackCredentialRequestSchema.safeParse({ value: v }).success;
    expect(ok("t")).toBe(true);
    expect(ok("")).toBe(false);
    expect(ok("a\u0000b")).toBe(false);
    expect(ok("x".repeat(STACK_CREDENTIAL_MAX_BYTES + 1))).toBe(false);
    expect(PutStackCredentialRequestSchema.safeParse({ value: "t", key: "other" }).success).toBe(
      false
    );
  });

  it("a workload-identity identifier is its provider's shape and nothing more", () => {
    const ok = (provider: string, identifier: string) =>
      StackWorkloadIdentityBindingSchema.safeParse({ provider, identifier }).success;
    expect(ok("aws-irsa", "arn:aws:iam::123456789012:role/path/scp-plan")).toBe(true);
    expect(ok("aws-irsa", "arn:aws:iam::123456789012:role/x\nkind: ClusterRoleBinding")).toBe(
      false
    );
    expect(ok("aws-irsa", 'arn:aws:iam::123456789012:role/x"')).toBe(false);
    expect(ok("gke-workload-identity", "scp-plan@my-project.iam.gserviceaccount.com")).toBe(true);
    expect(ok("gke-workload-identity", "scp-plan@evil.example.com")).toBe(false);
    expect(ok("azure-workload-identity", "0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
    expect(ok("azure-workload-identity", "arn:aws:iam::123456789012:role/x")).toBe(false);
    expect(ok("vault", "anything")).toBe(false);
  });

  it("a sealing key is exactly 32 bytes of base64", () => {
    const ok = (n: number) =>
      PutStackCredentialSealingKeyRequestSchema.safeParse({
        publicKey: Buffer.alloc(n, 1).toString("base64"),
        keyId: "a".repeat(64)
      }).success;
    expect(ok(32)).toBe(true);
    expect(ok(31)).toBe(false);
    expect(ok(33)).toBe(false);
  });
});
