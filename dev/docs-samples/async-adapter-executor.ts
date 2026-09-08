/** docs/v2-async-adapter.md — "Running commands". */
import type { Payload } from 'payload'
import type { GmcCommand, PayloadGmcEcommerceV2Options } from 'payload-plugin-gmc-ecommerce'

import { createGmcCommandExecutor, normalizeGmcV2Options } from 'payload-plugin-gmc-ecommerce'

export const buildWorker = (pluginOptions: PayloadGmcEcommerceV2Options) => {
  const execute = createGmcCommandExecutor(normalizeGmcV2Options(pluginOptions))

  return async (args: {
    command: GmcCommand
    operationId: string
    payload: Payload
    rootOperationId?: string
  }) => {
    const { command, operationId, payload, rootOperationId } = args
    const result = await execute({
      command,
      operationId,
      payload,
      rootOperationId,
    })
    return result
  }
}
