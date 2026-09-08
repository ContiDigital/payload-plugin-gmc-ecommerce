# Fine’s Gallery ECS integration for GMC 2.0

Internal deployment mapping; excluded from the npm package. Updated September 7,
2026 after the rc.37 production rollout. Stable 2.0 uses the same runtime and
schema as rc.37. Publication and activation status must be verified from npm,
GitHub Actions, and the deployed ECS task configuration, not inferred from a
package version or this document.

## Host contract

Fine’s installs an exact registry version of `payload-plugin-gmc-ecommerce`.
There is no committed sibling tarball or `file:` dependency. The implementation
is in `src/plugins/MerchantCenter` in finesgallery/finesgallery-beta.

- `runtime.ts` projects canonical published products. A valid positive suggested
  price is preferred; otherwise a valid positive regular price is used. Missing,
  non-finite, and non-positive prices are excluded. The same projection supplies
  Merchant API content and the TSV artifact.
- `resolveIdentities` retains the model ID independently of price eligibility so
  product hooks can remove a previously published offer when it becomes
  ineligible. A direct `product.publish` command for a legacy listing without a
  v2 publication row must include its known identity in `previousIdentities`.
- `artifactStore.ts` uses `generatedAt` and S3 compare-and-set promotion. Older
  pointers without that timestamp can be replaced by a current build.
- `asyncAdapter.ts` persists immutable commands and reports aggregate root and
  descendant status. Indexed `raw_subject` scopes status and health by instance.
- `gmcCommand.ts` calls the singleton plugin executor with `command`,
  `operationId`, `rootOperationId`, and `payload`. It does not allocate global
  source versions or persist activation records. The projector may supply
  `sourceVersion` solely as Google’s optional offer `versionNumber`.
- `requireTransaction: true` joins canonical changes and the immutable outbox
  through Payload’s `req`. Per-key immutability and per-subject FIFO publication
  locks remain; the obsolete global GMC lock and reconcile exclusivity query
  are removed. The shared rate limiter has its own short account-counter lock.
- `remotePageSize: 1000` and `maxRemoteReconcilePages: 100` cover up to 100,000
  remote offers, including a 28,000-offer catalog with headroom. Catalog pages
  contain 25 products; their separate ceiling is 2,000 pages.

## Schema and integrated changes

The owner generated `src/migrations/20260907_165839.ts`. Its corrected additive,
repeatable migration was tested up/down/up against a production-schema clone
and applied to production as batch 144. It adds unified offer/store publication
state and AsyncOperations lineage, immutable-key, digest and subject fields.
Its `down` intentionally retains schema and data for code rollback; destructive
cleanup requires a separate reviewed migration. rc.37 → 2.0.0 adds no schema delta.

Host PRs #23–28 separately integrated the migration, transaction plumbing,
revalidation outbox, watermark queue, Merchant adapter and infrastructure.
PR #29 corrected deployment/runtime issues exposed by the rollout. PR #22 fixed
the unrelated factory-dashboard import cycle. The original accumulated working
tree was preserved; it was not deployed wholesale.

## Production infrastructure and controls

The dedicated FIFO Merchant queue/worker handles durable commands. A shared
PostgreSQL limiter bounds rolling or concurrent workers to the configured
account budget, currently 300 Merchant requests/minute. This is below the
observed 500/minute data-source read quota. Recheck live quotas before raising it.

GitHub repository variables feed the production workflow:

| Variable | Meaning |
| --- | --- |
| `GOOGLE_MERCHANT_V2_ENABLED` | Installs automatic product/dependency hooks and API routes on the web service. Set `true` for normal production operation. |
| `GOOGLE_MERCHANT_WORKER_ENABLED` | Enables the dedicated Merchant worker independently, allowing a dark canary. Set `true` for normal operation. |
| `GOOGLE_MERCHANT_DATA_SOURCE_EXCLUSIVE` | Enables broad remote orphan deletion only when the instance exclusively owns every configured source. Otherwise keep `false`. |
| `GOOGLE_MERCHANT_MAX_REQUESTS_PER_MINUTE` | Shared account budget; 300 was validated during rollout. |
| `GOOGLE_BUSINESS_PROFILE_RETIRED_STORE_CODES` | Store inventory that must be removed; retain codes until reconciliation verifies deletion. |

Excluding unpriced products is unconditional host policy, not an orphan-deletion
setting. Remove known legacy unpriced listings with explicit product commands
carrying their verified identities. Broad orphan deletion is separate: the
account also contains automated-feed and UI products that this integration does
not own.

API routes are under `/api/merchant-center/v2`. The public artifact route is
`/api/merchant-center/products.tsv`. Feed builds run daily at 09:15 UTC and full
catalog reconciliation Sundays at 09:30 UTC. Automatic hooks handle changes
between sweeps. Run an initial catalog publication after activation and monitor
aggregate descendants, not just coordinator completion.

Web and all five worker pools reuse one built image digest. Deploy the complete
SST stack so the new web image and worker definitions converge together. Avoid
isolated service/IAM target updates that can resolve a worker against the old
web image. Build retry cleanup preserves the mounted `.next/cache` directory.
Queue URLs resolve from explicit environment variables before SST links because
SST’s Resource proxy throws for missing links.

Merchant S3 permissions allow Get/Put only in `gmc-feeds/v2/*`; object deletion
is denied. Bucket-level ListBucket allows absent initial pointers to return 404
rather than 403 and exposes bucket key metadata; it does not grant access to
snapshot object contents. The stored Google private key is JSON-decoded when
quoted, then normalized for escaped newlines.

## Verified rc.37 baseline

[Production run 34179420700](https://github.com/finesgallery/finesgallery-beta/actions/runs/34179420700)
deployed commit `b938ca37406b731449dd4bdfb9cedd37ea4268e0` successfully. Web and all
workers stabilized on the same image, with the CDN invalidation complete.

- Host CI: 3,341 application tests and 125 real-Postgres tests, plus type checks,
  lint, architecture and service-documentation gates.
- Plugin CI: package gates and Node/Payload/database matrices. The packaged real
  Google insert/read/update/delete lifecycle also passed locally against the
  separate test data source; stable tags require that lifecycle again in CI.
- Production Google canary BF-178 and its local inventory succeeded through the
  deployed worker, with matching desired/published digests and verified remote
  price/image/source. Root 3316 and all descendants completed.
- Feed operation 3321 succeeded on its first attempt: 4,419 unique eligible offers,
  12,285,912 bytes, valid HTTPS images and a verified S3 pointer/hash.
- Merchant ledger, main queue and DLQ were empty and health was `ok` afterward.
- Authenticated factory order browsing and an isolated 3.56 MB warehouse image
  upload/download/decode/delete passed using the existing admin API credential.
  This does not substitute for an exact warehouse-user browser session.

The initial deployment intentionally had web ingress disabled and the worker
enabled for canaries. The owner subsequently authorized automatic publication
and removal of unpriced listings. That authorization supersedes the dark-rollout
hold. Check current ECS environment and operation evidence for activation and
completion; a GitHub variable alone does not change a running task.

## Stable release and recovery

The stable tag must match `package.json` and be contained in `main`. The release
workflow checks the package, database matrix, dependency audit and packaged live
Merchant lifecycle before publishing verified tarball bytes to npm `latest`.
Live lifecycle fixtures use separate test source 10621021803; production source
10516572582 is reserved for actual host catalog work. Install stable from the
registry, update the host lockfile and deploy the shared image.

For rollback, stop new ingress, inspect aggregate work and drain/pause the worker
before running older command code. Retain publication rows and immutable ledger
history. The built-in Payload Jobs adapter’s stale-running limitations are in
`docs/v2-operations.md`; Fine’s custom adapter has its own ledger/outbox recovery
and must be diagnosed through its measured health and SQS/DLQ state.
