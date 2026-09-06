/** README.md — "Running the worker": calling the executor from your own queue. */
import type { Payload } from 'payload'
import type {
  GmcCommand,
  PayloadGmcEcommerceV2Options,
} from 'payload-plugin-gmc-ecommerce'

import { createGmcCommandExecutor, normalizeGmcV2Options } from 'payload-plugin-gmc-ecommerce'

export const runCommand = async (args: {
  command: GmcCommand
  operationId: string
  payload: Payload
  pluginOptions: PayloadGmcEcommerceV2Options
  rootOperationId?: string
}): Promise<void> => {
  const { command, operationId, payload, pluginOptions, rootOperationId } = args

  const execute = createGmcCommandExecutor(normalizeGmcV2Options(pluginOptions))
  await execute({ command, operationId, payload, rootOperationId })
}
