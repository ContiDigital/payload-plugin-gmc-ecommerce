#!/usr/bin/env bash
#
# Pack smoke test — verifies the published package imports correctly.
# Runs: npm pack, installs the tarball in a temp dir, imports the default export.
#

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

rm -f ./*.tgz
pack_log="$(mktemp)"
npm pack >"$pack_log" 2>&1 || {
  cat "$pack_log"
  exit 1
}
pack_file="$(realpath "$(ls -1t ./*.tgz | head -n 1)")"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
  rm -f "$pack_log"
  rm -f "$pack_file"
}
trap cleanup EXIT

cd "$tmp_dir"
npm init -y >/dev/null
npm install "$pack_file" >/dev/null
node --input-type=module -e "import plugin from 'payload-plugin-gmc-ecommerce'; if (typeof plugin !== 'function') { throw new Error('default export is not a function') }"

echo "Pack smoke test passed."
