import type { Config, Endpoint, Where } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import { assertAccess } from '../server/utilities/access.js'
import { assertApiKeyAccess } from '../server/utilities/apiKeyAuth.js'
import {
  parseAnalyticsInput,
  parseBatchInput,
  parseDeleteProductInput,
  parseInitialSyncInput,
  parseMappingsInput,
  parseSyncProductInput,
} from '../server/utilities/validation.js'
import {
  createHandledEndpoint,
  createUserEndpoint,
  createWorkerEndpoint,
} from './endpointFactory.js'
import {
  DIRTY_SYNC_FILTER,
  getService,
  listMappings,
  replaceMappings,
  resolveDeleteIdentity,
  startBatchPushDispatch,
  startDirtySyncDispatch,
  startInitialSyncDispatch,
  startPullAllDispatch,
} from './endpointSupport.js'

export const applyEndpointEnhancements = (
  config: Config,
  options: NormalizedPluginOptions,
): Config => {
  if (!config.endpoints) {
    config.endpoints = []
  }

  const basePath = options.api.basePath

  const endpoints: Endpoint[] = [
    createUserEndpoint({
      method: 'post',
      options,
      parseBody: parseSyncProductInput,
      path: `${basePath}/product/push`,
      rateLimitKey: 'push',
      run: ({ body, req, service }) =>
        service.pushProduct({
          payload: req.payload,
          productId: body.productId,
        }),
    }),
    createUserEndpoint({
      method: 'post',
      options,
      parseBody: parseSyncProductInput,
      path: `${basePath}/product/pull`,
      rateLimitKey: 'pull',
      run: ({ body, req, service }) =>
        service.pullProduct({
          payload: req.payload,
          productId: body.productId,
        }),
    }),
    createUserEndpoint({
      method: 'post',
      options,
      parseBody: parseSyncProductInput,
      path: `${basePath}/product/delete`,
      rateLimitKey: 'delete',
      run: ({ body, req, service }) =>
        service.deleteProduct({
          payload: req.payload,
          productId: body.productId,
        }),
    }),
    createUserEndpoint({
      method: 'post',
      options,
      parseBody: parseSyncProductInput,
      path: `${basePath}/product/refresh`,
      rateLimitKey: 'refresh',
      run: ({ body, req, service }) =>
        service.refreshSnapshot({
          payload: req.payload,
          productId: body.productId,
        }),
    }),
    createUserEndpoint({
      method: 'post',
      options,
      parseBody: parseAnalyticsInput,
      path: `${basePath}/product/analytics`,
      rateLimitKey: 'analytics',
      run: ({ body, req, service }) =>
        service.getProductAnalytics({
          payload: req.payload,
          productId: body.productId,
          rangeDays: body.rangeDays,
        }),
    }),
    createUserEndpoint({
      method: 'post',
      options,
      parseBody: parseBatchInput,
      path: `${basePath}/batch/push`,
      rateLimitKey: 'batch-push',
      requiresService: false,
      run: ({ body, req }) =>
        startBatchPushDispatch({
          filter: body.filter as undefined | Where,
          jobId: `gmc-batch-${Date.now().toString(36)}`,
          metadata: {
            hasFilter: Boolean(body.filter),
            productCount: body.productIds?.length ?? 0,
            trigger: 'manual-batch-push',
          },
          options,
          productIds: body.productIds,
          req,
          triggeredBy: req.user?.email ?? 'system',
        }),
    }),
    createUserEndpoint({
      method: 'get',
      options,
      path: `${basePath}/mappings`,
      requiresService: false,
      run: ({ req }) => listMappings(req),
    }),
    createUserEndpoint({
      method: 'post',
      options,
      parseBody: parseMappingsInput,
      path: `${basePath}/mappings`,
      requiresService: false,
      run: ({ body, req }) =>
        replaceMappings({
          mappings: body.mappings,
          req,
        }),
    }),
    createHandledEndpoint({
      method: 'get',
      path: `${basePath}/health`,
      run: async (req) => {
        const service = getService(options)
        const url = new URL(req.url || '', 'http://localhost')
        const deep = url.searchParams.get('deep') === 'true'

        if (deep) {
          await assertAccess(req, options)
          return service.getHealthDeep({ payload: req.payload })
        }

        const health = service.getHealth()
        try {
          await assertAccess(req, options)
          return health
        } catch {
          const { merchant: _merchant, ...safeHealth } = health
          return safeHealth
        }
      },
    }),
    createHandledEndpoint({
      method: 'post',
      path: `${basePath}/cron/sync`,
      run: (req) => {
        assertApiKeyAccess(
          req,
          options.sync.schedule.apiKey,
          'Cron endpoint not configured. Set sync.schedule.apiKey in plugin options.',
        )

        return startDirtySyncDispatch({
          jobId: `gmc-cron-${Date.now().toString(36)}`,
          metadata: { trigger: 'cron-external' },
          options,
          req,
          triggeredBy: 'cron',
        })
      },
    }),
    createWorkerEndpoint({
      method: 'post',
      options,
      parseBody: parseSyncProductInput,
      path: `${basePath}/worker/product/push`,
      rateLimitKey: 'push',
      run: ({ body, req, service }) =>
        service.pushProduct({
          payload: req.payload,
          productId: body.productId,
        }),
    }),
    createWorkerEndpoint({
      method: 'post',
      options,
      parseBody: parseDeleteProductInput,
      path: `${basePath}/worker/product/delete`,
      rateLimitKey: 'delete',
      run: ({ body, req, service }) => {
        const resolvedIdentity = resolveDeleteIdentity(body.identity, options)

        return resolvedIdentity
          ? service.deleteProductByIdentity({
              identity: resolvedIdentity,
              payload: req.payload,
              productId: body.productId,
            })
          : service.deleteProduct({
              payload: req.payload,
              productId: body.productId,
            })
      },
    }),
    createWorkerEndpoint({
      method: 'post',
      options,
      path: `${basePath}/worker/batch/push-dirty`,
      rateLimitKey: 'batch-push',
      run: ({ req, service }) =>
        service.pushBatch({
          filter: DIRTY_SYNC_FILTER,
          payload: req.payload,
        }),
    }),
    createWorkerEndpoint({
      method: 'post',
      options,
      parseBody: parseInitialSyncInput,
      path: `${basePath}/worker/batch/initial-sync`,
      rateLimitKey: 'initial-sync',
      run: ({ body, req, service }) =>
        service.runInitialSync({
          overrides: body,
          payload: req.payload,
        }),
    }),
    createWorkerEndpoint({
      method: 'post',
      options,
      path: `${basePath}/worker/batch/pull-all`,
      rateLimitKey: 'pull-all',
      run: ({ req, service }) => service.pullAllProducts({ payload: req.payload }),
    }),
    createUserEndpoint({
      method: 'post',
      options,
      path: `${basePath}/batch/pull-all`,
      rateLimitKey: 'pull-all',
      requiresService: false,
      run: ({ req }) =>
        startPullAllDispatch({
          jobId: `gmc-pull-${Date.now().toString(36)}`,
          metadata: { trigger: 'manual-pull-all' },
          options,
          req,
          triggeredBy: req.user?.email ?? 'system',
        }),
    }),
    createUserEndpoint({
      method: 'post',
      options,
      parseBody: parseInitialSyncInput,
      path: `${basePath}/batch/initial-sync`,
      rateLimitKey: 'initial-sync',
      requiresService: false,
      run: ({ body, req }) =>
        startInitialSyncDispatch({
          jobId: `gmc-isync-${Date.now().toString(36)}`,
          metadata: { dryRun: body.dryRun, trigger: 'manual-initial-sync' },
          options,
          overrides: body,
          req,
          triggeredBy: req.user?.email ?? 'system',
        }),
    }),
    createUserEndpoint({
      method: 'post',
      options,
      path: `${basePath}/batch/push-dirty`,
      rateLimitKey: 'batch-push',
      requiresService: false,
      run: ({ req }) =>
        startDirtySyncDispatch({
          jobId: `gmc-batch-dirty-${Date.now().toString(36)}`,
          metadata: { trigger: 'manual-dirty-push' },
          options,
          req,
          triggeredBy: req.user?.email ?? 'system',
        }),
    }),
  ]

  config.endpoints.push(...endpoints)
  return config
}
