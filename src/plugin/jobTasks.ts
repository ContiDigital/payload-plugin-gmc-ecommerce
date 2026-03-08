import type { Config } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import {
  GMC_BATCH_PUSH_TASK_SLUG,
  GMC_DELETE_PRODUCT_TASK_SLUG,
  GMC_INITIAL_SYNC_TASK_SLUG,
  GMC_PULL_ALL_TASK_SLUG,
  GMC_PUSH_PRODUCT_TASK_SLUG,
  GMC_SYNC_DIRTY_TASK_SLUG,
} from '../constants.js'
import {
  buildBatchPushTaskConfig,
  buildDeleteProductTaskConfig,
  buildInitialSyncTaskConfig,
  buildPullAllTaskConfig,
  buildPushProductTaskConfig,
  buildSyncDirtyTaskConfig,
} from './jobTaskDefinitions.js'
export {
  queueBatchPushJob,
  queueDirtySyncJob,
  queueInitialSyncJob,
  queueProductDeleteJob,
  queueProductPushJob,
  queuePullAllJob,
  runQueuedGmcJobs,
} from './jobQueue.js'

const getTaskConfigBySlug = (
  config: Config,
  slug: string,
): Record<string, unknown> | undefined => {
  const tasks = config.jobs?.tasks
  if (!tasks) {
    return undefined
  }

  return tasks.find((task) => {
    return typeof task === 'object' && task !== null && 'slug' in task && task.slug === slug
  }) as Record<string, unknown> | undefined
}

const ensureJobsConfig = (config: Config): NonNullable<Config['jobs']> => {
  if (!config.jobs) {
    config.jobs = { tasks: [] }
  }

  if (!config.jobs.tasks) {
    config.jobs.tasks = []
  }

  return config.jobs
}

export const applyJobEnhancements = (
  config: Config,
  options: NormalizedPluginOptions,
): Config => {
  const jobs = ensureJobsConfig(config)

  if (!getTaskConfigBySlug(config, GMC_PUSH_PRODUCT_TASK_SLUG)) {
    jobs.tasks.push(buildPushProductTaskConfig(options) as never)
  }

  if (!getTaskConfigBySlug(config, GMC_DELETE_PRODUCT_TASK_SLUG)) {
    jobs.tasks.push(buildDeleteProductTaskConfig() as never)
  }

  if (!getTaskConfigBySlug(config, GMC_SYNC_DIRTY_TASK_SLUG)) {
    jobs.tasks.push(buildSyncDirtyTaskConfig() as never)
  }

  if (!getTaskConfigBySlug(config, GMC_BATCH_PUSH_TASK_SLUG)) {
    jobs.tasks.push(buildBatchPushTaskConfig() as never)
  }

  if (!getTaskConfigBySlug(config, GMC_INITIAL_SYNC_TASK_SLUG)) {
    jobs.tasks.push(buildInitialSyncTaskConfig() as never)
  }

  if (!getTaskConfigBySlug(config, GMC_PULL_ALL_TASK_SLUG)) {
    jobs.tasks.push(buildPullAllTaskConfig() as never)
  }

  return config
}
