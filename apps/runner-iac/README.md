# scp-runner-iac

Stub for M0. This is the source for the separate `scp-runner-iac` image: pinned
OpenTofu/Terraform plus a minimal run shim, used only by the isolated `scp-managed-iac`
executor (charter's Managed Execution Exception; DESIGN.md §12 Mode 2).

Not an npm workspace package — it is a plain Docker build context with no Node app code
(DESIGN.md §3). The Dockerfile, pinned tofu/terraform toolchain, and run shim land in **M7**
(BUILD_AND_TEST.md §8). Until then this directory exists only to hold the layout in place.
