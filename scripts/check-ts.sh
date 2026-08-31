#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pnpm --dir "${repository_root}" run check:ts:static
"${repository_root}/scripts/check-jellyfin-extension.sh"
NAMA_TEST_EXTENSION_READY=1 "${repository_root}/scripts/check-server-tests.sh"
