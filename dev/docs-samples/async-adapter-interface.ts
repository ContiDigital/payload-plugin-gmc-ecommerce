/** docs/v2-async-adapter.md — "The interface". */
import type { Config, Payload, PayloadRequest } from 'payload'
import type {
  GmcAsyncDispatchArgs,
  GmcAsyncHealth,
  GmcAsyncOperation,
  GmcDispatchReceipt,
  NormalizedGmcV2Options,
} from 'payload-plugin-gmc-ecommerce'

export type Adapter = {
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
  install?: (args: { config: Config; options: NormalizedGmcV2Options }) => Config
  capabilities?: { orderedBySubject?: boolean; scheduledDelivery?: boolean }
}
