#!/usr/bin/env bash
#
# Pack smoke test — verifies the published package imports correctly.
# Installs one exact tarball in a temp dir and imports every public server
# entrypoint. Pass the immutable release artifact as PACK_SMOKE_TARBALL or the
# first argument. With neither, a disposable tarball is packed inside the temp
# directory; the repository is never glob-deleted.
#

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
pack_log="$(mktemp)"
cleanup() {
  rm -rf "$tmp_dir"
  rm -f "$pack_log"
}
trap cleanup EXIT

provided_pack="${PACK_SMOKE_TARBALL:-${1:-}}"
if [[ -n "$provided_pack" ]]; then
  if [[ ! -f "$provided_pack" ]]; then
    echo "Pack smoke tarball does not exist: $provided_pack" >&2
    exit 1
  fi
  pack_file="$(realpath "$provided_pack")"
else
  cd "$repo_root"
  npm pack --silent --pack-destination "$tmp_dir" >"$pack_log" 2>&1 || {
    cat "$pack_log"
    exit 1
  }
  pack_name="$(tail -n 1 "$pack_log")"
  pack_file="$tmp_dir/$pack_name"
  if [[ ! -f "$pack_file" ]]; then
    cat "$pack_log"
    echo "npm pack did not produce the expected tarball" >&2
    exit 1
  fi
fi

cd "$tmp_dir"
npm init -y >/dev/null
npm install "$pack_file" >/dev/null
node --input-type=module -e "import plugin, { payloadGmcEcommerce } from 'payload-plugin-gmc-ecommerce'; if (typeof plugin !== 'function' || plugin !== payloadGmcEcommerce) { throw new Error('v2 root export is incomplete') }"
node --input-type=module -e "import plugin, { assertFeedArtifactDescriptor, createGmcCommandExecutor, GmcAsyncWorkflowConflictError, GMC_V2_COMMAND_SCHEMA_VERSION, GMC_V2_MAX_TARGETED_PRODUCT_IDS } from 'payload-plugin-gmc-ecommerce/v2'; const conflict = new GmcAsyncWorkflowConflictError('smoke-operation'); if (typeof plugin !== 'function' || typeof createGmcCommandExecutor !== 'function' || typeof assertFeedArtifactDescriptor !== 'function' || conflict.code !== 'GMC_ASYNC_WORKFLOW_CONFLICT' || conflict.statusCode !== 409 || GMC_V2_COMMAND_SCHEMA_VERSION !== 2 || GMC_V2_MAX_TARGETED_PRODUCT_IDS !== 1000) { throw new Error('v2 export is incomplete') }"
node --input-type=module -e "const root = await import('payload-plugin-gmc-ecommerce'); if ('createMerchantService' in root || 'SYNC_MODES' in root) { throw new Error('legacy symbols leaked into the v2 root') }"
node --input-type=module -e "import { buildGmcOperationsCollection, payloadJobsAsyncAdapter } from 'payload-plugin-gmc-ecommerce'; const adapter = payloadJobsAsyncAdapter(); if (typeof payloadJobsAsyncAdapter !== 'function' || typeof buildGmcOperationsCollection !== 'function' || adapter.name !== 'payload-jobs' || adapter.capabilities.scheduledDelivery !== true || typeof adapter.install !== 'function') { throw new Error('payloadJobsAsyncAdapter export is incomplete') }"
test -f node_modules/payload-plugin-gmc-ecommerce/docs/v2-architecture.md
test -f node_modules/payload-plugin-gmc-ecommerce/docs/v2-async-adapter.md
test -f node_modules/payload-plugin-gmc-ecommerce/docs/v2-setup.md
test -f node_modules/payload-plugin-gmc-ecommerce/docs/v2-operations.md
test -f node_modules/payload-plugin-gmc-ecommerce/docs/v2-migration.md
# Internal notes must never ship.
test ! -e node_modules/payload-plugin-gmc-ecommerce/docs/internal

echo "Pack smoke test passed."
