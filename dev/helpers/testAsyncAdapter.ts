import type { GmcAsyncAdapter } from 'payload-plugin-gmc-ecommerce/v2'

/**
 * In-memory async adapter for the dev app. It satisfies the durable-outbox
 * capability contract v2 requires (see `PayloadGmcEcommerceV2Options['async']`)
 * without persisting anything — dispatched commands are simply acknowledged
 * and immediately forgotten.
 *
 * Placeholder until Task 8 adds the built-in Payload Jobs adapter
 * (`payloadJobsAsyncAdapter`).
 */
let n = 0

export const testAsyncAdapter: GmcAsyncAdapter = {
  name: 'dev-in-memory',
  capabilities: {
    delivery: 'at-least-once',
    durable: true,
    exclusiveCatalogReconciliation: true,
    globalSourceVersion: true,
    orderedBySubject: true,
    transactionAware: true,
    workflowStatus: true,
  },
  dispatch: async () => ({ operationId: String(++n), state: 'queued' }),
  getOperation: async () => null,
  health: async () => ({ checkedAt: new Date().toISOString(), status: 'ok' }),
}
