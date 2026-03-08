import type { Config, Payload } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import { GMC_SYNC_QUEUE_NAME } from '../constants.js'
import { createPluginLogger } from '../server/utilities/logger.js'

const startupNoticeRegistry = new WeakSet<Payload>()

const wrapOnInit = (
  config: Config,
  onInit: NonNullable<Config['onInit']>,
): void => {
  const existingOnInit = config.onInit

  config.onInit = async (payload) => {
    if (existingOnInit) {
      await existingOnInit(payload)
    }

    await onInit(payload)
  }
}

export const applyScheduledSync = (
  config: Config,
  options: NormalizedPluginOptions,
): Config => {
  if (options.sync.schedule.strategy !== 'payload-jobs') {
    return config
  }

  wrapOnInit(config, (payload) => {
    if (startupNoticeRegistry.has(payload)) {
      return
    }

    startupNoticeRegistry.add(payload)

    const log = createPluginLogger(payload.logger, { operation: 'payload-jobs' })
    log.info('GMC payload-jobs mode enabled', {
      note: options.sync.mode === 'scheduled'
        ? 'Run a Payload jobs worker for queue "gmc-sync" and use the GMC cron endpoint or your scheduler to enqueue dirty-sync jobs.'
        : 'Run a Payload jobs worker for queue "gmc-sync" to process queued GMC tasks.',
      queue: GMC_SYNC_QUEUE_NAME,
      syncMode: options.sync.mode,
    })
  })

  return config
}
