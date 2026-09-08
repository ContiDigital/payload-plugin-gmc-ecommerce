# GMC Plugin 2.0 Defensible Release Implementation Plan

> **Historical implementation plan.** The implementation was merged in PR #3.
> Unchecked boxes and rc.35 instructions below are historical, not outstanding
> rollout work. Current contracts are in `docs/v2-*.md`; the deployed host mapping
> is in `docs/internal/fines-ecs.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the uncommitted 2.0.0-rc.35 tree into a 2.0.0 that keeps the projector + durable-command engine, removes the unverifiable host contract, ships a built-in Payload Jobs adapter, and fixes the eleven defects found in review.

**Architecture:** The v2 engine (host projector → validated ProductInput → durable commands → worker executor → hidden publication state → Merchant API v1 transport) stays. The global `sourceVersion` ordering scheme is replaced by content digests plus per-row `desiredAt` ordering; Google `versionNumber` is sent only when the host projector supplies one. Local-inventory state folds into the main publication collection. A `payloadJobsAsyncAdapter` implements the (now small) adapter contract on Payload Jobs with its own ledger collection. Legacy 1.x code moves to a `release/1.x` branch.

**Tech Stack:** Payload CMS 3.37–3.88 (peer `>=3.37.0 <4.0.0`), TypeScript 5.6, vitest 4, SWC build, pnpm 10. Official SQLite/Postgres/Mongo adapters. Merchant API v1 via raw fetch.

**Spec:** The review verdict and cut list at https://claude.ai/code/artifact/3c428bfb-f627-4a9f-adcc-4d09ccf4c197 (also summarized in `docs/v2-architecture.md` after Task 11 rewrites it). Executors should read this plan's "Global Constraints" and each task's "Interfaces" block; they carry the decisions.

## Global Constraints

- Node `^22.12.0 || >=24.0.0`; Payload peer range `>=3.37.0 <4.0.0`. Nothing may import undocumented adapter internals (`payload.db.pool`, `payload.db.client`). `payload.db.drizzle` and `payload.db.tables` are the documented direct-query surface on SQL adapters; `payload.db.updateOne` on Mongo.
- Two hard requirements never regress: (1) product content is derived only by `products.project` from canonical data; (2) every unit of Merchant work is a durable command executed by `createGmcCommandExecutor` in a worker. No `setImmediate`, no detached promises.
- Every task ends with `pnpm lint && pnpm exec tsc --noEmit && pnpm exec vitest --run` green. Tasks that touch state or hooks also run `pnpm exec vitest --run dev/v2.int.spec.ts` (SQLite). Task 12 runs the full `pnpm test:v2:db-matrix` (needs Docker; available locally).
- Fine's Gallery (`~/src/finesgallery-beta`, uncommitted tree using rc.35) must keep type-checking against the new types with at most the documented small edits listed in Task 13. Do not edit Fine's files in this plan.
- Command schema version stays `2`. Removed command fields become "accepted and ignored" in `assertGmcCommand` for one release so a queued rc.35 row cannot poison a worker; they are not emitted.
- Commit after every task on branch `release/2.0` with message prefix `feat(v2):`, `fix(v2):`, `refactor(v2):`, or `docs(v2):`. Never push.
- Keep coverage thresholds in `vitest.config.js` passing; lower a threshold only in the task that deletes code and note it in the commit.

---

### Task 1: Preserve legacy 1.x on its own branch and baseline the rc.35 tree

**Files:**
- Create: `../gmc-1x` git worktree on new branch `release/1.x` from `HEAD` (`a48d1c4`)
- Create: `release/2.0` branch from the current working tree (snapshot commit of rc.35 as-is)

**Interfaces:**
- Produces: branch `release/1.x` containing the uncommitted "1.3.0" legacy fixes with `package.json` version `1.3.0`; branch `release/2.0` whose first commit is the untouched rc.35 tree. All later tasks run on `release/2.0`.

- [ ] **Step 1: Snapshot rc.35 on `release/2.0`**

```bash
cd /home/marsupial/src/payload-plugin-gmc-ecommerce
git checkout -b release/2.0
git rm --cached payload-plugin-gmc-ecommerce-2.0.0-rc.35.tgz 2>/dev/null || true
printf '\n*.tgz\n' >> .gitignore
git add -A
git commit -m "chore(v2): snapshot Codex 2.0.0-rc.35 working tree before rework

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 2: Create the 1.x worktree from the last committed 1.x state**

```bash
git worktree add ../gmc-1x -b release/1.x a48d1c4
```

- [ ] **Step 3: Copy the legacy 1.3.0 changes into the worktree**

The uncommitted legacy changes live in these paths on `release/2.0`. Copy them verbatim:

```bash
cd /home/marsupial/src/payload-plugin-gmc-ecommerce
for p in src/hooks src/plugin src/server src/types/index.ts src/collections src/components dev/draft-safety.int.spec.ts; do
  rm -rf "../gmc-1x/$p"; mkdir -p "../gmc-1x/$(dirname $p)"; cp -r "$p" "../gmc-1x/$p"
done
cp src/v2/runtimeConstants.ts ../gmc-1x/src/server/services/sub-services/runtimeConstants.ts
```

Then in the worktree fix the two imports that pointed at `src/v2`:

```bash
cd ../gmc-1x
sed -i "s#'../../../v2/runtimeConstants.js'#'./runtimeConstants.js'#" src/server/services/sub-services/googleApiClient.ts src/server/services/sub-services/retryService.ts
grep -rn "v2/" src && echo "UNEXPECTED v2 import remains" || echo "no v2 imports"
```

Set the version and changelog: in `../gmc-1x/package.json` set `"version": "1.3.0"`. Copy the `## [1.3.0]` and `## [1.2.2]` sections from `CHANGELOG.md` on `release/2.0` (lines under those headings) into `../gmc-1x/CHANGELOG.md` above `## [1.2.1]`.

- [ ] **Step 4: Verify the 1.x branch is green**

```bash
cd ../gmc-1x && pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc --noEmit && pnpm exec vitest --run
```
Expected: all pass (the legacy suites plus `dev/draft-safety.int.spec.ts`). If `pnpm install` complains about the lockfile, run `pnpm install` without `--frozen-lockfile` and commit the lockfile.

- [ ] **Step 5: Commit on `release/1.x`**

```bash
cd ../gmc-1x && git add -A && git commit -m "fix: 1.3.0 draft-safe bookkeeping writes and push/pull race fixes

Carried over from the Codex working tree so 1.x hosts can receive these
fixes independently of the 2.0 rewrite.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Remove legacy source from the 2.0 tree and fix packaging

**Files:**
- Delete: `src/legacy.ts`, `src/hooks/`, `src/plugin/`, `src/collections/`, `src/components/`, `src/constants.ts`, `src/exports/client.ts`, `src/exports/rsc.ts`, `src/server/sync/`, `src/server/services/merchantService.ts` and its test, `src/server/utilities/{apiKeyAuth,inboundRateLimit,logger,pathUtils,recordUtils,validation}.ts` and their tests, `docs/setup-guide.md`, `docs/local-inventory-setup.md`, `dev/draft-safety.int.spec.ts`, `dev/seed.ts` legacy fields (rewrite, see step 3)
- Modify: `package.json` (`files`, `exports`, scripts), `dev/tsconfig.json` (drop `/legacy*` paths), `dev/payload.config.ts` (use v2), `dev/app/(payload)/admin/importMap.js` (regenerate), `scripts/pack-smoke.sh`, `src/types/index.ts` (keep only MC wire types), `src/index.ts`

**Interfaces:**
- Produces: `src/types/index.ts` exporting only `MC*` wire types, `AccessFn`, `GetCredentialsFn`, `CredentialResolution`, `RateLimitConfig`, `DistributedRateLimitStore`. Everything under `src/server/` that remains is used by `src/v2/`: `services/sub-services/{googleApiClient,rateLimiterService,retryService}.ts`, `utilities/{access,http,httpError}.ts`.

- [ ] **Step 1: Delete the legacy tree**

```bash
git rm -r src/legacy.ts src/hooks src/plugin src/collections src/components src/constants.ts src/exports/client.ts src/exports/rsc.ts src/server/sync src/server/services/merchantService.ts src/server/services/__tests__ src/server/utilities/apiKeyAuth.ts src/server/utilities/inboundRateLimit.ts src/server/utilities/logger.ts src/server/utilities/pathUtils.ts src/server/utilities/recordUtils.ts src/server/utilities/validation.ts src/server/utilities/__tests__/inboundRateLimit.test.ts src/server/utilities/__tests__/pathUtils.test.ts src/server/utilities/__tests__/validation.test.ts docs/setup-guide.md docs/local-inventory-setup.md dev/draft-safety.int.spec.ts
```

- [ ] **Step 2: Trim `src/types/index.ts`**

Remove every legacy type (sync modes, job types, field mappings, `MCSyncMeta`, `SyncResult`, `PayloadGMCEcommercePluginOptions`, `NormalizedPluginOptions`, `LocalInventory*Result`, `ProductsCollectionConfig`, `CategoriesCollectionConfig`, …). Keep, unchanged: `AccessFn`, `CredentialResolution`, `GetCredentialsFn`, `RateLimitConfig`, `DistributedRateLimitStore`, `MC_AVAILABILITY`, `MC_CONDITION`, `MCAvailability`, `MCCondition`, `MCPrice`, `MCInterval`, `MCProductDetail`, `MCStructuredContent`, `MCShipping*`, `MCTax` (delete this one too, Google v1 has no `taxes`), `MCFreeShippingThreshold`, `MCArrayField`, `MCUrlArrayField`, `MCCustomAttribute`, `MCProductIdentity`, `MCProductInput`, `MCProductAttributes` (remove `taxes`). Run `pnpm exec tsc --noEmit` and delete anything it reports unused in v2; add nothing.

- [ ] **Step 3: Rewrite `dev/payload.config.ts` and `dev/seed.ts` for v2**

Replace the plugin block with a v2 configuration using the Payload Jobs adapter placeholder (the adapter arrives in Task 8; until then use the in-memory adapter from `dev/v2.int.spec.ts` extracted to `dev/helpers/testAsyncAdapter.ts`). Products collection fields: `title`, `sku` (unique), `price` (number), `description`, `imageUrl`, `availability` select, `versions: { drafts: true }`. Projection:

```ts
project: ({ doc }) => ({
  products: [{
    contentLanguage: 'en', feedLabel: 'PRODUCTS', offerId: String(doc.sku),
    productAttributes: {
      availability: doc.availability === 'in_stock' ? 'IN_STOCK' : 'OUT_OF_STOCK',
      description: String(doc.description ?? ''),
      imageLink: String(doc.imageUrl ?? ''),
      link: `https://example.test/products/${String(doc.sku)}`,
      price: { amountMicros: String(Math.round(Number(doc.price ?? 0) * 1_000_000)), currencyCode: 'USD' },
      title: String(doc.title),
    },
  }],
}),
resolveIdentities: ({ doc }) => [{ contentLanguage: 'en', feedLabel: 'PRODUCTS', offerId: String(doc.sku) }],
```
Keep the SQLite adapter with `transactionOptions: {}`. Remove `categories` collection wiring from the plugin block (keep the collection in `dev/` as a catalog dependency example with `select: ({ doc }) => ({ name: doc.name, googleCategoryId: doc.googleCategoryId })`). Regenerate the import map: `pnpm dev:generate-importmap`.

- [ ] **Step 4: Fix `package.json`**

```json
"exports": {
  ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./v2": { "import": "./dist/exports/v2.js", "types": "./dist/exports/v2.d.ts", "default": "./dist/exports/v2.js" }
},
"files": ["dist", "docs/*.md", "LICENSE", "README.md", "CHANGELOG.md"],
```
Remove the `packageManager` field (commit `fc39ab9` removed it deliberately; corepack auto-adds it). Version stays `2.0.0-rc.35` until Task 11 sets `2.0.0`.

- [ ] **Step 5: Fix `scripts/pack-smoke.sh`**

Delete the assertions about `dist/legacy.js`, `dist/plugin`, `dist/constants.js`, `dist/types/index.js`, `dist/server/utilities/validation.js`, `docs/setup-guide.md`, `docs/local-inventory-setup.md`, the README `canonicalRevision`/`isSellable` string checks, and the `legacy` entrypoint check. Keep: root import check, `/v2` import check, the "legacy symbols leaked" check. Add: `node -e "import('payload-plugin-gmc-ecommerce').then(m => { if (typeof m.payloadJobsAsyncAdapter !== 'function') throw new Error('missing payloadJobsAsyncAdapter') })"` (will fail until Task 8; leave it commented with `# enabled in Task 8` and uncomment there).

- [ ] **Step 6: Verify and commit**

```bash
pnpm lint && pnpm exec tsc --noEmit && pnpm exec vitest --run && pnpm build && pnpm pack:smoke
git add -A && git commit -m "refactor(v2): remove legacy 1.x source from the 2.0 tree

Legacy lives on release/1.x. Package ships dist/ and public docs only.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Simplify the option and adapter contract

**Files:**
- Modify: `src/v2/types.ts`, `src/v2/config.ts`, `src/v2/plugin.ts`, `src/v2/__tests__/config.test.ts`, `src/v2/__tests__/plugin.test.ts`, `src/v2/__tests__/hooks.test.ts` (adapter fixtures)

**Interfaces:**
- Produces (in `src/v2/types.ts`):

```ts
export type GmcAsyncAdapterCapabilities = {
  /** Required for catalogDependencies[].scheduleAt. */
  scheduledDelivery?: boolean
  /** Documented expectation; not verified. Default assumed true. */
  orderedBySubject?: boolean
} & Record<string, unknown> // rc.35 flags are accepted and ignored

export type GmcAsyncAdapter = {
  name: string
  capabilities?: GmcAsyncAdapterCapabilities
  /** Optional: add collections/tasks the adapter needs. Called once by the plugin. */
  install?: (args: { config: Config; options: NormalizedGmcV2Options }) => Config
  dispatch: (args: GmcAsyncDispatchArgs) => Promise<GmcDispatchReceipt>
  getOperation: (args: { instanceId: string; operationId: string; payload: Payload; req?: PayloadRequest }) => Promise<GmcAsyncOperation | null>
  health: (args: { instanceId: string; payload: Payload; req?: PayloadRequest }) => Promise<GmcAsyncHealth>
}

export type GmcAsyncDispatchArgs = {
  command: GmcCommand; idempotencyKey: string; parentOperationId?: string; payload: Payload
  req?: PayloadRequest; rootOperationId?: string; scheduledFor?: string; subject: string
} // sourceVersion removed

export type GmcCommandExecutionContext = {
  command: GmcCommand; operationId: string; payload: Payload; rootOperationId?: string
  /** @deprecated ignored since 2.0.0; retained so rc.35 workers compile. */
  sourceVersion?: string
}

export type PayloadGmcEcommerceV2Options = {
  access?: AccessFn                      // default: hasDefaultPluginAccess from server/utilities/access
  additionalDataSourceIds?: string[]
  api?: { basePath?: `/${string}`; exposeWorkerEndpoint?: boolean }
  async: GmcAsyncAdapter
  catalogDependencies?: GmcCatalogDependencyConfig[]
  catalogGlobalDependencies?: GmcCatalogGlobalDependencyConfig[]
  dataSourceId: string
  disabled?: boolean
  feeds?: GmcFeedConfig[]                // optional, default []
  getCredentials: GetCredentialsFn
  instanceId?: string
  localInventory?: GmcV2LocalInventoryConfig  // publicationState removed from it
  merchantId: string
  /** @deprecated ignored since 2.0.0. */
  productIngestion?: { mode: 'api-primary' }
  products: GmcProductSourceConfig
  publicationState?: { collectionSlug?: string }   // custom store removed
  rateLimit?: RateLimitConfig
  reconciliation?: GmcReconciliationConfig          // unchanged union
  /** Fail closed when an automatic hook runs without an ambient transaction. Default false. */
  requireTransaction?: boolean
  workerAccess?: GmcWorkerAccessFn        // required iff api.exposeWorkerEndpoint
}
```
- `NormalizedGmcV2Options` gains `requireTransaction: boolean`, `feeds: GmcFeedConfig[]` (may be empty), `workerAccess?: GmcWorkerAccessFn`; loses `productIngestion`; `publicationState.store` and `localInventory.publicationState` are gone. `GmcPublicationStateStore` and `GmcLocalInventoryPublicationStateStore` types stay exported for now (Task 6 makes them internal).

- [ ] **Step 1: Write failing config tests**

Add to `src/v2/__tests__/config.test.ts` (replace tests that assert the removed rejections):

```ts
it('accepts an adapter with only dispatch/getOperation/health', () => {
  const options = normalizeGmcV2Options({ ...baseOptions, async: { name: 'x', dispatch, getOperation, health } })
  expect(options.async.name).toBe('x')
})
it('ignores rc.35 capability flags', () => {
  expect(() => normalizeGmcV2Options({ ...baseOptions, async: { ...minimalAdapter, capabilities: { durable: true, globalSourceVersion: true } } })).not.toThrow()
})
it('defaults feeds to an empty array', () => {
  expect(normalizeGmcV2Options({ ...baseOptions, feeds: undefined }).feeds).toEqual([])
})
it('requires workerAccess only when the worker endpoint is exposed', () => {
  expect(() => normalizeGmcV2Options({ ...baseOptions, workerAccess: undefined })).not.toThrow()
  expect(() => normalizeGmcV2Options({ ...baseOptions, workerAccess: undefined, api: { exposeWorkerEndpoint: true } })).toThrow(/workerAccess/)
})
it('still requires scheduledDelivery for scheduleAt dependencies', () => {
  expect(() => normalizeGmcV2Options({ ...baseOptions, catalogDependencies: [{ collection: 'promos', select: () => null, scheduleAt: () => [] }] })).toThrow(/scheduledDelivery/)
})
it('defaults requireTransaction to false and access to the default plugin access', () => {
  const options = normalizeGmcV2Options({ ...baseOptions, access: undefined })
  expect(options.requireTransaction).toBe(false)
  expect(typeof options.access).toBe('function')
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest --run src/v2/__tests__/config.test.ts` → the new tests fail on `TypeError` from `assertAsyncAdapter`/feeds.

- [ ] **Step 3: Implement** in `config.ts`: replace `assertAsyncAdapter` with dispatch/getOperation/health + name checks only; `scheduledDelivery` check `!== true` when a dependency has `scheduleAt`; drop the `productIngestion` check; `feeds` optional (`options.feeds ?? []`, max 100); `workerAccess` required only with `api.exposeWorkerEndpoint === true`; `access` default `hasDefaultPluginAccess`; `requireTransaction: options.requireTransaction ?? false`; remove `publicationState.store` and `localInventory.publicationState` validation. In `plugin.ts`: call `options.async.install?.({ config, options })` first and continue with its result; stop pushing a local-inventory collection (Task 6 folds it); keep the product-collection and dependency hook wiring.

- [ ] **Step 4: Update existing tests** that construct adapters with seven flags: replace fixtures with `{ name, dispatch, getOperation, health }`; delete tests asserting rejection of missing flags, missing feeds, missing `productIngestion`.

- [ ] **Step 5: Verify and commit**

```bash
pnpm lint && pnpm exec tsc --noEmit && pnpm exec vitest --run
git add -A && git commit -m "refactor(v2): shrink the async adapter and option contract

Capability self-attestation, mandatory feeds, productIngestion, and
mandatory workerAccess are gone. Transactions become opt-in via
requireTransaction (implemented in the next task).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Opt-in transactions and draft-churn suppression in hooks

**Files:**
- Modify: `src/v2/hooks.ts`, `src/v2/plugin.ts`, `src/v2/__tests__/hooks.test.ts`, `dev/v2.int.spec.ts`, `dev/v2.no-transactions.int.spec.ts`

**Interfaces:**
- Consumes: `NormalizedGmcV2Options.requireTransaction` from Task 3.
- Produces: `createGmcV2TransactionBeforeChangeHook(options)` etc. now take `options` and only throw when `requireTransaction === true`; otherwise `assertTransactionalHookRequest` becomes `warnOnceWithoutTransaction(req, options)` which logs `payload.logger.warn` once per process (module-level `Set<string>` keyed by instanceId) with the message `payload-plugin-gmc-ecommerce: dispatching Merchant command outside a database transaction; a crash between commit and dispatch is repaired by catalog.reconcile. Set requireTransaction: true to fail closed.`

- [ ] **Step 1: Failing tests** in `hooks.test.ts`:

```ts
it('dispatches without a transaction by default and warns once', async () => {
  const warn = vi.fn()
  const req = { payload: { logger: { warn } }, transactionID: undefined } as never
  await createGmcV2AfterChangeHook(options)({ doc, operation: 'create', previousDoc: {}, req } as never)
  await createGmcV2AfterChangeHook(options)({ doc, operation: 'create', previousDoc: {}, req } as never)
  expect(dispatch).toHaveBeenCalledTimes(2)
  expect(warn).toHaveBeenCalledTimes(1)
})
it('fails closed when requireTransaction is true', async () => {
  const strict = normalizeGmcV2Options({ ...raw, requireTransaction: true })
  await expect(createGmcV2AfterChangeHook(strict)({ doc, operation: 'create', previousDoc: {}, req: { transactionID: Promise.resolve(null) } } as never)).rejects.toMatchObject({ code: 'GMC_TRANSACTION_REQUIRED' })
})
it('skips a draft save over a document that was already draft-only', async () => {
  await createGmcV2AfterChangeHook(options)({ doc: { ...doc, _status: 'draft' }, operation: 'update', previousDoc: { ...doc, _status: 'draft' }, req } as never)
  expect(dispatch).not.toHaveBeenCalled()
})
it('still dispatches when a published document is saved as a draft', async () => {
  await createGmcV2AfterChangeHook(options)({ doc: { ...doc, _status: 'draft' }, operation: 'update', previousDoc: { ...doc, _status: 'published' }, req } as never)
  expect(dispatch).toHaveBeenCalledTimes(1)
})
```
Also keep one test that a resolved `Promise<string>` transactionID and a numeric transactionID both pass under `requireTransaction: true`.

- [ ] **Step 2: Run** `pnpm exec vitest --run src/v2/__tests__/hooks.test.ts` → fails.

- [ ] **Step 3: Implement** the branch in `hooks.ts`; `plugin.ts` passes `options` to the before hooks; add the draft→draft short-circuit in `createGmcV2AfterChangeHook` (only when `typeof current._status === 'string'`).

- [ ] **Step 4: Update integration specs.** In `dev/v2.int.spec.ts` change the `rejects non-transactional writes` test to build a second Payload instance? No: simplest is to set `requireTransaction: true` in that spec's options (it already runs with transactions) so the test keeps its meaning, and add one assertion in `dev/v2.no-transactions.int.spec.ts` that with the default options a `disableTransaction: true` create succeeds and dispatches (ensure the file also runs on SQLite without env gating: remove the `GMC_V2_TEST_NO_TRANSACTIONS` gate; it should use SQLite with default `sqliteAdapter` (no `transactionOptions`) and one product create).

- [ ] **Step 5: Verify and commit** — `pnpm lint && pnpm exec tsc --noEmit && pnpm exec vitest --run && pnpm exec vitest --run dev/v2.int.spec.ts dev/v2.no-transactions.int.spec.ts`; commit `fix(v2): make ambient transactions opt-in and stop draft autosave churn`.

---

### Task 5: Replace global source versions with digest + desiredAt ordering in the state store

**Files:**
- Modify: `src/v2/types.ts` (`GmcPublicationState`, `GmcPublicationClaim`, `GmcPublicationStateStore`), `src/v2/state/payloadStateStore.ts`, `src/v2/state/atomicStateUpdate.ts`, `src/v2/state/collection.ts`, `src/v2/__tests__/payloadStateStore.test.ts`, `src/v2/__tests__/publicationCollection.test.ts`, `dev/v2.int.spec.ts`

**Interfaces:**
- Produces:

```ts
export type GmcPublicationState = {
  desiredAt?: string; desiredDigest?: string
  error?: { code?: string; message: string; retryable?: boolean }
  identity: MCProductIdentity; operationId: string; productId?: GmcDocumentID
  publishedAt?: string; publishedDigest?: string
  remoteMissing?: boolean; remoteStatus?: Record<string, unknown>; remoteVersion?: string
  revision: number
  status: GmcPublicationStatus       // 'delete-pending' | 'deleted' | 'failed' | 'publish-pending' | 'published'
  storeCode?: string                 // set only for local-inventory rows (Task 6)
  updatedAt: string
}
export type GmcPublicationClaim = { desiredAt: string; desiredDigest: string; identity: MCProductIdentity; operationId: string; payload: Payload; productId: GmcDocumentID }
export type GmcPublicationStateStore = {
  claimPublication(claim): Promise<GmcPublicationState>   // rules below
  get({ identity, payload }): Promise<GmcPublicationState | null>
  listByProduct({ payload, productId }): Promise<GmcPublicationState[]>
  markDeletePending({ identity, operationId, payload, productId?, onlyIfDesiredBefore? }): Promise<GmcPublicationState | null>
  markDeleted({ identity, operationId, payload, productId? }): Promise<GmcPublicationState>
  markFailed({ error, identity, operationId, payload }): Promise<void>
  markObserved({ identity, observedAt, payload, remoteMissing, remoteStatus?, remoteVersion? }): Promise<void>
  markPublished({ ...claim, publishedAt }): Promise<GmcPublicationState>
}
```
Claim rules (replace the version rules): (a) ownership: existing `productId` differs and status not `deleted` → throw `GmcIdentityOwnershipError`; (b) ordering: `existing.desiredAt > claim.desiredAt` → return existing unchanged (stale claim); (c) same digest already `published` → update only `desiredAt`/`operationId` and return; (d) otherwise set `publish-pending` with the claim. `markDeletePending`: return `null` (skip) when `onlyIfDesiredBefore` is given and existing `desiredAt >= onlyIfDesiredBefore` and status not `deleted`; return `null` when `productId` is given and existing productId differs; otherwise set `delete-pending`. `markDeleted`/`markFailed`/`markPublished` guard on `operationId` as today. `deleteVersion`, `desiredVersion`, `publishedVersion`, `GmcSourceVersionConflictError` are removed. `remoteVersion` stays (informational).

- [ ] **Step 1: Replace `atomicStateUpdate.ts`** with the drizzle path:

```ts
import { and, eq } from 'drizzle-orm'
export const atomicUpdatePublicationState = async (args) => {
  const db = args.payload.db as unknown as { name?: string; drizzle?: any; tables?: Record<string, any>; tableNameMap?: Map<string, string>; updateOne: Function }
  const data = { ...args.data, revision: args.existing.revision + 1, updatedAt: new Date().toISOString() }
  if (db.name === 'mongoose') { /* unchanged */ }
  if (db.name !== 'postgres' && db.name !== 'sqlite') throw new TypeError(`unsupported adapter ${db.name}`)
  const logical = toSnakeCase(args.collectionSlug)               // from 'payload/shared'
  const table = db.tables?.[db.tableNameMap?.get(logical) ?? logical]
  if (!table) throw new TypeError(`GMC publication table ${logical} is not registered`)
  const rows = await db.drizzle.update(table).set(toColumns(data)).where(and(eq(table.id, args.existing.id), eq(table.revision, args.existing.revision))).returning()
  return rows[0] ? fromDrizzleRow(rows[0]) : null
}
```
`toColumns` maps camelCase keys to the drizzle column objects on `table` (drizzle columns are exposed as camelCase properties on the table object: `table.desiredAt`). JSON fields (`error`, `remoteStatus`) are passed as objects on Postgres and `JSON.stringify` on SQLite (check `db.name`). Delete `FIELD_COLUMNS`, `snakeCase`, `sqlValue`, `quoteIdentifier`, `resolveTableName`. Verify `toSnakeCase` is exported from `payload/shared`; if not, copy Payload's implementation (`packages/payload/src/utilities/toSnakeCase.ts`, 4 lines) into the file.

- [ ] **Step 2: Fix duplicate detection**

```ts
import { ValidationError } from 'payload'
const isDuplicateError = (error: unknown): boolean =>
  error instanceof ValidationError ||
  (typeof error === 'object' && error !== null && ((error as { code?: unknown }).code === 11000 ||
    /duplicate|unique constraint/i.test(String((error as { message?: unknown }).message))))
```

- [ ] **Step 3: Rewrite the store** per the interface. Trim `collection.ts` to: unique index on `key`; indexes on `productId`, `status`, `storeCode`; no index on `revision`, `merchantId`, `dataSourceName`, `contentLanguage`, `feedLabel`, `offerId`, `operationId`, `desiredAt`. Fields removed: `deleteVersion`, `desiredVersion`, `publishedVersion`. Field added: `storeCode` (text, optional, index).

- [ ] **Step 4: Rewrite `payloadStateStore.test.ts`** as a state-machine spec against the in-memory double, but make the double throw a real `new ValidationError({ collection, errors: [{ message: 'unique', path: 'key' }] })` on duplicate keys, and add a concurrent-create test (two claims for a new identity resolve to one row). Update the two `dev/v2.int.spec.ts` state tests to the new rules (drop version assertions; keep ownership, delete then re-claim, and the two-worker CAS race).

- [ ] **Step 5: Verify and commit** — unit + `dev/v2.int.spec.ts`; commit `refactor(v2): digest and desiredAt ordering replace global source versions in publication state`.

---

### Task 6: Fold local-inventory state into the main store

**Files:**
- Delete: `src/v2/state/localInventoryCollection.ts`, `src/v2/state/localInventoryPayloadStateStore.ts`, `src/v2/__tests__/localInventoryPayloadStateStore.test.ts`
- Modify: `src/v2/types.ts`, `src/v2/state/payloadStateStore.ts`, `src/v2/exports/v2.ts` (remove the two exports), `scripts/pack-smoke.sh` (remove their checks), `dev/v2.int.spec.ts`

**Interfaces:**
- Produces on `GmcPublicationStateStore`: `claimLocalInventory({ ...GmcPublicationClaim, storeCode })`, `getLocalInventory({ identity, payload, storeCode })`, `markLocalInventoryPublished({ ...claim, storeCode, publishedAt })`, `markLocalInventoryFailed({ error, identity, operationId, payload, storeCode })`. Rows use key `${merchantId}|${dataSourceName}|${identityKey}|store:${storeCode}` and set `storeCode`. `listByProduct` excludes rows with `storeCode`. Same claim rules as Task 5 (ownership, desiredAt ordering, digest skip).

- [ ] **Step 1: Failing test** in `payloadStateStore.test.ts`: claim local inventory for store A and store B on one identity → two rows; product `listByProduct` returns only the product row; stale `desiredAt` local claim returns existing.
- [ ] **Step 2: Implement**, delete the separate files, update exports and pack smoke, update the int spec's local-inventory test to the new API.
- [ ] **Step 3: Verify and commit** `refactor(v2): fold local-inventory publication state into the main collection`.

---

### Task 7: Executor rework

**Files:**
- Modify: `src/v2/executor.ts`, `src/v2/commands.ts`, `src/v2/types.ts` (command types), `src/v2/catalog.ts`, `src/v2/feed/buildFeed.ts` (artifact `sourceVersion` → `generatedAt` ordering), `src/v2/__tests__/executor.test.ts`, `src/v2/__tests__/commands.test.ts`, `src/v2/__tests__/feedBuilder.test.ts`, `dev/v2.int.spec.ts`

**Interfaces:**
- Consumes: Task 5/6 store API.
- Produces command shapes (schema version stays 2; removed fields are tolerated-and-ignored by `assertGmcCommand` for one release):

```ts
GmcProductPublishCommand   = { type: 'product.publish'; cause; productId; previousIdentities?; requestedAt; schemaVersion }
// product.delete is removed from emitters; assertGmcCommand still accepts it and the executor maps it to product.publish semantics with previousIdentities = identities
GmcOfferPublishCommand     = { type: 'offer.publish'; input; productId; digest: string; versionNumber?: string; verifyRemote?: boolean; requestedAt; schemaVersion }
GmcOfferDeleteCommand      = { type: 'offer.delete'; identity; expectedProductId?; onlyIfDesiredBefore?: string; requestedAt; schemaVersion }
GmcCatalogReconcileCommand = { type: 'catalog.reconcile'; phase?: 'desired' | 'remote'; cursor?; pageIndex?; pageToken?; startedAt?; requestedAt; schemaVersion }
GmcLocalInventoryApplyCommand = { type: 'localInventory.apply'; identity; inventory; productId; storeCode; digest: string; requestedAt; schemaVersion }
GmcProductProjection = { products: GmcProjectedProductInput[]; sourceVersion?: string; warnings? }  // sourceVersion optional; forwarded as versionNumber when present
GmcCommandExecutionContext.sourceVersion is ignored.
```
Executor behavior:
1. `product.publish`: read published doc; if absent → dispatch `offer.delete` for `previousIdentities ∪ listByProduct` (product row rows only). Else canonicalize; stale identities → `offer.delete`; each product → `claimPublication({ desiredAt: requestedAt, desiredDigest: digest, ... })`; skip if returned state is `published` with same digest and cause is not `reconcile`; skip if returned state has a newer `desiredAt`; else dispatch `offer.publish { digest, versionNumber: projection.sourceVersion }`. One claim, not two. Local inventory: unchanged fan-out but idempotency key uses the digest instead of a version.
2. `offer.publish`: claim again (same rules); if `published` with same digest and `!verifyRemote` → skip. Ownership GET only when `options.dataSourceNames.length > 1` **or** `verifyRemote`; on `verifyRemote` and remote present with same digest → `markObserved` and skip. Insert `{ ...input, ...(versionNumber ? { versionNumber } : {}) }`. `markPublished`.
3. `offer.delete`: `markDeletePending({ onlyIfDesiredBefore, expectedProductId })` → null → skip; delete (404 ok); `markDeleted`.
4. `catalog.reconcile`: phase `desired` = dispatch `product.publish { cause: 'reconcile' }` children exactly like `catalog.publish` (no inline loop), then a `remote` continuation with `startedAt`. Phase `remote` unchanged except the orphan predicate: state missing, or `deleted`, or `desiredAt < startedAt`; orphan delete child carries `onlyIfDesiredBefore: startedAt`.
5. `localInventory.apply`: fence = base product row exists, `published`, same productId; `claimLocalInventory` (skip if newer desiredAt or same digest already published); ownership GET only if multiple sources (keep the "processed product not ready" retry when the base row is `publish-pending`); insert/delete; `markLocalInventoryPublished`. Remove the second and third rechecks.
6. `status.refresh`: run inline for ≤ 1,000 identities (no fan-out).
7. `feed.build`: artifact descriptor `sourceVersion` becomes `generatedAt` (the command `requestedAt`); replay skip when current pointer `generatedAt >= requestedAt`.
8. Remove `compareSourceVersions`, `isDeletionFenced`, `isLocalInventoryMutationFenced`, the `sourceVersion` int64 assertion at the entry.

- [ ] **Step 1: Write the behavior tests first** in `executor.test.ts` using a real in-memory store (reuse the double from `payloadStateStore.test.ts`; export it from `src/v2/__tests__/helpers/memoryStateStore.ts`) instead of the canned mock. Required cases: (a) reconcile over an unchanged published product performs a GET and no insert (defect 1); (b) `product.publish` redelivery after the child completed → skipped, no dispatch; (c) legacy `product.delete` command without `productId` deletes every listed identity (defect 4); (d) an `offer.delete` with `onlyIfDesiredBefore` older than the row's `desiredAt` is skipped; (e) single-source publish performs no ownership GET; multi-source does; (f) `feed.build` replay with equal `generatedAt` skips after verifying the artifact; (g) `localInventory.apply` skips when the base row is not `published`; retries (`GmcProcessedProductNotReadyError`) when it is `publish-pending`.

- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4:** update `commands.test.ts` (ignored-field tolerance test: `assertGmcCommand({ type: 'offer.delete', identity, deleteIfDesiredVersionBefore: '1', ... })` does not throw), `feedBuilder.test.ts`, `dev/v2.int.spec.ts` (no more `sourceVersion` on execute calls).

- [ ] **Step 5: Verify and commit** `refactor(v2): executor uses digests and desiredAt; reconcile no longer re-inserts the catalog`.

---

### Task 8: Built-in Payload Jobs async adapter

**Files:**
- Create: `src/v2/adapters/payloadJobs.ts`, `src/v2/adapters/operationsCollection.ts`, `src/v2/__tests__/payloadJobsAdapter.test.ts`, `dev/v2.jobs.int.spec.ts`
- Modify: `src/exports/v2.ts` (+`payloadJobsAsyncAdapter`), `src/index.ts`, `scripts/pack-smoke.sh` (uncomment), `scripts/test-v2-db-matrix.sh` (run the new spec on all three databases), `dev/payload.config.ts` (use it)

**Interfaces:**
- Produces:

```ts
export type PayloadJobsAsyncAdapterOptions = {
  queue?: string          // default 'gmc'
  taskSlug?: string       // default 'gmc-command'
  collectionSlug?: string // default 'gmc-operations'
  retries?: number        // default 5 (Payload task retries; exponential backoff base 30s)
  /** Test seam: override how the task obtains an executor. */
  createExecutor?: (options: NormalizedGmcV2Options) => ReturnType<typeof createGmcCommandExecutor>
}
export const payloadJobsAsyncAdapter: (options?: PayloadJobsAsyncAdapterOptions) => GmcAsyncAdapter
```
Ledger collection `gmc-operations` (hidden, `access` from plugin options, `versions` off): `key` text unique indexed; `subject` text indexed; `commandType` text; `command` json; `commandDigest` text; `parentOperationId` text indexed; `rootOperationId` text indexed; `jobId` text; `state` select (`queued|running|succeeded|failed|dead-lettered|cancelled`) indexed; `attempts` number; `error` json; `result` json; `scheduledFor` date; `startedAt` date; `finishedAt` date.

`install({ config, options })`: pushes the collection and registers the task `{ slug, retries: { attempts: retries, backoff: { type: 'exponential', delay: 30_000 } }, inputSchema: [{ name: 'operationId', type: 'text', required: true }], handler }` on `config.jobs.tasks`, creating `config.jobs` if absent. Never overrides an existing task with the same slug (throw instead).

`dispatch`: `payload.create` ledger row with `state: 'queued'` (pass `req`); on duplicate (`isDuplicateError` from Task 5, moved to `src/v2/state/duplicateError.ts`) → `payload.find` by key; if `commandDigest !== getGmcCommandIdempotencyDigest(command)` throw `GmcAsyncIdempotencyConflictError`; else return `{ operationId: String(existing.id), state: 'queued' }`. Then `payload.jobs.queue({ task: taskSlug, queue, input: { operationId }, req, waitUntil: scheduledFor ? new Date(scheduledFor) : undefined })` and `payload.update` the row with `jobId` (pass `req`). Return `{ operationId, state: 'queued' }`.

Task handler `({ input, req })`: `payload = req.payload`; load row; if `state === 'succeeded'` → return `{ output: {} }`. Update `state: 'running', attempts + 1, startedAt`. Run `execute({ command: row.command, operationId, rootOperationId: row.rootOperationId ?? operationId, payload })`. Success → `state: 'succeeded', result, finishedAt`. Error → `classifyGmcCommandError`; if `!retryable` or `attempts >= retries + 1` → `state: retryable ? 'dead-lettered' : 'failed'`, persist `error`, and **return** `{ output: {} }` (do not throw: avoids a poison retry loop; the ledger is the truth); else persist `error`, `state: 'queued'`, and **throw** so Payload retries. Executor is created once per process via a module-level `WeakMap<NormalizedGmcV2Options, executor>`.

`getOperation`: row by id where `subject` starts with `gmc:${instanceId}:`; `rootId = row.rootOperationId ?? id`; six `payload.count` calls (`where: { rootOperationId: equals rootId, state: equals s }`) plus the root row's own state → `childCounts` and aggregate `state` by the documented precedence (dead-lettered > failed > running > queued > succeeded); `requestedState` = row.state; timestamps from the row.

`health`: counts for the instance: `queued` older than 15 minutes (`createdAt < now-15m` and `scheduledFor` null or past) → `degraded: 'queue_backlog_stale'`; any `dead-lettered` in the last 24h → `degraded`; a thrown DB error → `error`. Details include the counts.

- [ ] **Step 1: Unit tests** (`payloadJobsAdapter.test.ts`) with a fake `payload` (`create`/`find`/`update`/`count`/`jobs.queue` spies): dispatch creates row then queues job with `waitUntil`; duplicate key returns the original id; duplicate with different digest throws the conflict error; handler marks succeeded; handler on retryable error marks queued and throws; on terminal error marks failed and returns; `getOperation` aggregates precedence.
- [ ] **Step 2: Integration** `dev/v2.jobs.int.spec.ts` modeled on `dev/v2.int.spec.ts`: plugin configured with `payloadJobsAsyncAdapter({ createExecutor: () => fakeExecutor })`, create a published product → one `gmc-operations` row and one `payload-jobs` row; `await payload.jobs.run({ queue: 'gmc' })` → fake executor called with the `product.publish` command, row `succeeded`; `GET` operation via `adapter.getOperation` returns `succeeded`; a `scheduleAt` dependency dispatch sets `waitUntil` in the future and `jobs.run` does not execute it.
- [ ] **Step 3: Implement**; wire `dev/payload.config.ts` to it; add the spec to `scripts/test-v2-db-matrix.sh` after `dev/v2.int.spec.ts` for each database.
- [ ] **Step 4: Verify** unit + both int specs on SQLite; commit `feat(v2): built-in Payload Jobs async adapter`.

---

### Task 9: Canonical validation cut and TSV fixes

**Files:**
- Modify: `src/v2/canonical.ts`, `src/v2/feed/tsv.ts`, `src/types/index.ts`, `src/v2/__tests__/canonical.test.ts`, `src/v2/__tests__/tsv.test.ts`

**Interfaces:**
- `canonicalizeProductInput({ input, sourceVersion? })` keeps: identity rules, `Price` shape (`amountMicros` int64 string, 3-letter currency), int64/timestamp wire shapes, `customAttributes` value/groupValues exclusivity, legacy-row normalization (`[{ value }]` arrays), recursive key sort + digest. Removes: required title/description/link/imageLink/availability/price, text length caps, `salePrice < price`, `availabilityDate` for PREORDER/BACKORDER, highlight count, productDetails length caps, URL count caps, the `legacyLocal` rejection. Unknown fields still pass through. `taxes` removed from `MCProductAttributes` and from TSV columns.
- TSV: rows sorted by code-unit comparison of the identity key (`a < b ? -1 : 1`); shipping serializes Google's documented sub-attribute order `country:region:postal_code:location_id:location_group_name:service:price:min_handling_time:max_handling_time:min_transit_time:max_transit_time` with **no quoting**, and unknown shipping sub-fields throw (consistent fail-closed); scalar cells are not quoted (tabs/newlines already stripped); structured title/description with `DIGITAL_SOURCE_TYPE_UNSPECIFIED` emits `content` only; column `pickup_SLA`; unknown top-level attributes are **omitted with a warning collected on the feed result** (`warnings: GmcProjectionWarning[]` on `serializeCanonicalTsv`'s return) instead of throwing — only enum values without a documented text spelling still throw.

- [ ] **Step 1: Failing tests**: a supplemental input with only identity + `customLabel0` canonicalizes; a 600-char `productDetails.attributeValue` passes; `legacyLocal: true` passes; a golden digest test pins the hex for a fixed fixture; `taxes` is rejected as an unknown-but-passed-through field (it passes through; assert the type no longer has it via `// @ts-expect-error`); TSV row order is identical under `LANG=C` and `LANG=sv_SE` (set `process.env.LANG` cannot change ICU; instead assert the sort uses code units by feeding `['Z', 'a', 'é']` identities and expecting `Z, a, é`); shipping row with transit times; unknown attribute produces a warning not a throw.
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Verify and commit** `fix(v2): stop rejecting valid ProductInputs; deterministic and spec-correct TSV`.

---

### Task 10: Transport, rate limiter, and endpoint defects

**Files:**
- Modify: `src/server/services/sub-services/rateLimiterService.ts`, `retryService.ts`, `googleApiClient.ts`, `src/v2/errors.ts`, `src/v2/endpoints.ts`, `src/v2/__tests__/endpoints.test.ts`, `src/v2/__tests__/errors.test.ts`, `src/server/services/sub-services/__tests__/rateLimiterService.test.ts`, `googleApiClient.test.ts`, `src/v2/__tests__/googleTransport.test.ts`

- [ ] **Step 1: Failing tests**: `RateLimitQueueOverflowError` is classified non-retryable by `classifyGmcCommandError` and is not retried by `createRetryService`; a distributed-store reservation error (`claimSlot` rejects, or returns a reset more than 65s away) is classified **retryable** (introduce `RateLimitStoreError extends Error { code = 'GMC_RATE_LIMIT_STORE'; retryable = true }` and throw it instead of `TypeError`); `GoogleApiError` has no enumerable `responseBody` (assert `JSON.stringify(error)` lacks the body; keep `apiMessage`, `reason`, `fieldLocation`); `MAX_MERCHANT_RESPONSE_BYTES` is 8 MiB; the worker endpoint returns 403 before parsing when `workerAccess` returns false (send an invalid body and expect 403, not 400); an executor error on the worker endpoint returns `{ code, message, retryable }` from `classifyGmcCommandError` with status 500 when retryable and 422 when not; `googleApiClient.test.ts` asserts the exact insert URL `accounts/1/productInputs:insert?dataSource=accounts%2F1%2FdataSources%2F2` and the delete URL with the base64url name and `dataSource` query.
- [ ] **Step 2: Run** → fail. **Step 3: Implement** (also hoist the regex in `parseRemoteProduct`, drop the `productStatus` size re-serialization, delete the duplicate `assertGmcApiPrimaryDataSource` call in the executor's cache path, and delete the six credential size caps keeping `createPrivateKey` validation). **Step 4: Verify and commit** `fix(v2): rate-limit classification, error retention, worker endpoint auth order`.

---

### Task 11: Documentation, changelog, version, CI

**Files:**
- Rewrite: `README.md`, `docs/v2-architecture.md`, `docs/v2-setup.md`, `docs/v2-async-adapter.md`, `docs/v2-operations.md`, `docs/v2-migration.md`
- Move: `docs/v2-fines-ecs.md` → `docs/internal/fines-ecs.md` (excluded from the package by `files`), prepend a note that it describes the rc.35 contract and lists what Task 13 changes.
- Modify: `CHANGELOG.md` (collapse rc.1–rc.35 into one `## [2.0.0] - 2026-09-01`), `package.json` (`version: 2.0.0`, description), `.github/workflows/ci.yml` (drop nothing; add `dev/v2.jobs.int.spec.ts` to the Payload compatibility job), `.github/workflows/release.yml` (unchanged), `vitest.config.js` thresholds (keep or adjust after measuring)

**README structure (target ≤ 300 lines, written for a Payload developer):** What it does (3 sentences) · Requirements · Install · Quick start with `payloadJobsAsyncAdapter` (the Task 8 example) and `payload.jobs.run` / `autoRun` · How projection works (`project`, `resolveIdentities`, `products: []`, optional `sourceVersion`) · Catalog dependencies and Globals (`select`, `resolveProductIds`, `scheduleAt`) · Endpoints table · Publication state and reconciliation (detect-only default; `exclusive-data-sources` deletes only identities with no state row, a `deleted` row, or a row not re-claimed by this run) · Feeds (optional; TSV; artifact stores) · Local inventory · Custom async adapters (link) · Transactions (`requireTransaction`) · Migrating from 1.x (link) · License.

**CHANGELOG 2.0.0 entry sections:** Breaking (root export is v2; 1.x removed, available on `release/1.x`; options renamed/removed list; command field changes; state collection schema: removed `deleteVersion/desiredVersion/publishedVersion`, added `storeCode`, local-inventory collection removed) · Added (Payload Jobs adapter, `requireTransaction`, `install` hook) · Fixed (the eleven review defects, one line each) · Removed (global source version contract, custom state stores, mandatory feeds, `productIngestion`).

- [ ] **Step 1: Write** all of the above. Every code sample must type-check: put each sample in `dev/docs-samples/*.ts` covered by `pnpm exec tsc --noEmit` through `dev/tsconfig.json`.
- [ ] **Step 2: Verify** `pnpm release:check` (lint, tsc, coverage, build, pack smoke). **Step 3: Commit** `docs(v2): 2.0.0 documentation and changelog`.

---

### Task 12: Full verification

- [ ] `pnpm release:check`
- [ ] `pnpm test:v2:db-matrix` (SQLite, PostgreSQL, MongoDB, including `dev/v2.jobs.int.spec.ts` and the no-transactions spec)
- [ ] `pnpm pack --pack-destination /tmp/claude-1000/-home-marsupial-src-payload-plugin-gmc-ecommerce/f3dbc8ee-a7ed-49e8-93a6-4b9d014677ea/scratchpad/` then in `~/src/finesgallery-beta` run `pnpm exec tsc --noEmit -p tsconfig.json` with `node_modules/payload-plugin-gmc-ecommerce` temporarily replaced by the extracted tarball (`rm -rf node_modules/payload-plugin-gmc-ecommerce && tar -xzf <tgz> -C /tmp/x && mv /tmp/x/package node_modules/payload-plugin-gmc-ecommerce`). Record the type errors: they must be only the ones listed in Task 13. Restore Fine's `node_modules` afterwards (`pnpm install --offline`).
- [ ] Optional live smoke if `dev/.env` has the test data source: `pnpm test:live`.
- [ ] Commit any fixes; tag nothing.

---

### Task 13: Fine's Gallery follow-up (documented, not executed here)

Write `docs/internal/fines-ecs.md` "2.0.0 delta" section listing exactly:
1. `package.json`: replace the `file:` dependency with `payload-plugin-gmc-ecommerce@2.0.0` once published (or `link:` locally), regenerate the lockfile.
2. `src/plugins/MerchantCenter/runtime.ts`: remove `productIngestion`, `workerAccess` (worker endpoint is off), `localInventory.publicationState`; keep `capabilities` (ignored) or trim to `{ scheduledDelivery: true }`; `project` may drop `sourceVersion` (or keep it, it is forwarded as `versionNumber`).
3. `src/lib/jobs/handlers/gmcCommand.ts`: stop computing `sourceVersion`; pass `{ command, operationId, rootOperationId, payload }`.
4. `src/lib/jobs/gmcOrdering.ts`, activation records in `payload_kv`, the global GMC advisory lock in `enqueueImmutableAsyncOperation.ts`, and the reconcile exclusivity query: delete. Keep per-key immutability, the outbox, the FIFO publisher, and aggregate `getOperation`.
5. `asyncAdapter.ts`/`health`: filter on the indexed `raw_subject` column, not `input->>'subject'`.
6. Generate the Payload migration for `gmc-publications-v2` (new shape), the `async_operations` lineage columns, and the enum values; drop the `gmc-local-inventory-publications-v2` table creation.
7. Split the working tree into separate PRs: transactions + `req` plumbing; revalidate outbox; watermark queue; GMC v2; infra.
