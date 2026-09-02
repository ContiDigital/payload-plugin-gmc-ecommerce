import type { GmcAsyncAdapter } from 'payload-plugin-gmc-ecommerce/v2'

/**
 * In-memory async adapter for the dev app. It implements the minimal
 * dispatch/getOperation/health contract (see `GmcAsyncAdapter`) without
 * persisting anything — dispatched commands are simply acknowledged and
 * immediately forgotten.
 *
 * Placeholder until Task 8 adds the built-in Payload Jobs adapter
 * (`payloadJobsAsyncAdapter`).
 */
let n = 0

export const testAsyncAdapter: GmcAsyncAdapter = {
  name: 'dev-in-memory',
  dispatch: async () => ({ operationId: String(++n), state: 'queued' }),
  getOperation: async () => null,
  health: async () => ({ checkedAt: new Date().toISOString(), status: 'ok' }),
}
