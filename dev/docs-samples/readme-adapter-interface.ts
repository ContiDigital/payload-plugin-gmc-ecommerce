/** README.md — "Running the worker": the adapter interface. */
import type { Config, Payload, PayloadRequest } from 'payload'
import type {
  GmcAsyncDispatchArgs,
  GmcAsyncHealth,
  GmcAsyncOperation,
  GmcDispatchReceipt,
  NormalizedGmcV2Options,
} from 'payload-plugin-gmc-ecommerce'

export type GmcAsyncAdapter = {
  name: string
  dispatch: (args: GmcAsyncDispatchArgs) => Promise<GmcDispatchReceipt>
  getOperation: (args: {
    instanceId: string
    operationId: string
    payload: Payload
    req?: PayloadRequest
  }) => Promise<GmcAsyncOperation | null>
  health: (args: {
    instanceId: string
    payload: Payload
    req?: PayloadRequest
  }) => Promise<GmcAsyncHealth>
  /** Optional: add collections or tasks to the Payload config. */
  install?: (args: { config: Config; options: NormalizedGmcV2Options }) => Config
  capabilities?: { orderedBySubject?: boolean; scheduledDelivery?: boolean }
}
