#!/bin/sh
# The vendored-skopeo entry point, installed at /opt/scp/bin/skopeo by the Dockerfile (M15.5 c1;
# pin: tools/skopeo/pin.env, provenance: tools/skopeo/README.md).
#
# Unlike the vendored cosign (a static ko-built binary), the pinned skopeo comes from the official
# Fedora-based quay.io/skopeo/stable image and is DYNAMICALLY linked against Fedora sonames that
# do not exist in the Debian-based SCP runtime image. So the Dockerfile vendors the binary
# together with its closed shared-library closure and Fedora's own ELF loader under
# /opt/scp/libexec/skopeo, and this wrapper runs the binary against exactly those vendored
# libraries — never the host's. The host distribution's glibc/libs are irrelevant to it.
d=/opt/scp/libexec/skopeo
exec "$d/lib/ld-linux-x86-64.so.2" --library-path "$d/lib" "$d/skopeo" "$@"
