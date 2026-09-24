# =============================================================================================
# scp-builder-rpm — the image the shipped `scp-build-rpm-v1` catalog template runs (M28.1, ADR-0053).
#
# NOT a runner. The managed runners (`apps/runner-*`) are CommanderSCP executing under the charter's
# scoped exception; this is the opposite case — an image in the SHIPPED CATALOG, run by the org's
# own Argo Workflows when SCP triggers it, exactly as `moby/buildkit` is for `scp-build-image-v1`.
# SCP never launches it. That is why it lives outside `apps/runner-*` (that pattern is the air-gap
# gate's census of managed runners) and is still bundled, retargeted and CI-built like one.
#
# WHY A FIRST-PARTY IMAGE AT ALL. `scp-build-image-v1` gets away with two upstream images because
# BuildKit and git are each published ready to run. rpmbuild is not: no maintained public image
# ships it preinstalled (measured 2026-09-23 — `fedora:43`, `fedora-toolbox:43` and `almalinux:9`
# all lack `rpm-build`), and installing it at run time is a `dnf install` against the internet,
# which an air-gapped build pod cannot do and a connected one should not depend on. So the
# toolchain is installed HERE, once, at image build, and the image is what travels.
#
# EL9, NOT FEDORA. An RPM is built for the distribution it is built ON — `%{dist}`, the glibc it
# links against, the macro set. The hosts CommanderSCP coordinates host operations on are the
# enterprise dnf family (the ops lane's allowlist admits apt and dnf), so the default builder
# produces `.el9` packages. A component that needs another target binds a template of its own.
#
# THE TOOLCHAIN IS FIXED, AND THAT IS THE SCOPE. rpmbuild's own `BuildRequires` check runs before
# anything is compiled, so a spec needing a package this image lacks fails LOUDLY with rpmbuild's
# "Failed build dependencies" list — it never reaches the network, because there is none to reach.
#
# `docker build -t scp-builder-rpm:dev apps/builder-rpm` is the only build command for this image.
# =============================================================================================
FROM almalinux:9@sha256:3a3fa7f043b142bc8008c8b308d39b47d2c84008addcd52f9f9a7a82d2a90474

# rpm-build (rpmbuild + rpmspec), the C toolchain most specs assume, and curl for the publish.
# `dnf clean all` so the image carries no repository metadata — nothing in it can resolve a package.
RUN dnf -y install --setopt=install_weak_deps=False \
      rpm-build gcc make tar gzip findutils \
    && dnf clean all \
    && rm -rf /var/cache/dnf /var/lib/dnf/repos

# The SAME uid as the image template's builder (1000), so `fsGroup` on the pod's emptyDirs works
# identically for both catalog entries. Non-root is not a relaxation to be argued here: nothing in
# an rpmbuild needs root, which is the whole security story of this template (see its header).
RUN useradd --uid 1000 --user-group --create-home --home-dir /home/builder builder

COPY build-rpm.sh /usr/local/bin/scp-build-rpm
RUN chmod 0555 /usr/local/bin/scp-build-rpm

USER 1000:1000
ENTRYPOINT ["/usr/local/bin/scp-build-rpm"]
