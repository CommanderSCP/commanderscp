#!/usr/bin/env bash

set -euo pipefail
mkdir -pv /data/git/.ssh
chmod -Rv 700 /data/git/.ssh
[ ! -d /data/gitea/conf ] && mkdir -pv /data/gitea/conf

# prepare temp directory structure
mkdir -pv "${GITEA_TEMP}"
chmod -v ug+rwx "${GITEA_TEMP}"