#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/service/_common.sh
source "${SCRIPT_DIR}/service/_common.sh"

require_node_bin
cd "$ROOT_DIR"
node dist/main.js doctor
