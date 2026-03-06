import type { Config, Endpoint, Where } from 'payload'

import crypto from 'crypto'

import type { MerchantService } from '../server/services/merchantService.js'
import type { NormalizedPluginOptions } from '../types/index.js'

import { createMerchantService } from '../server/services/merchantService.js'
import { assertAccess } from '../server/utilities/access.js'
import { errorResponse, jsonResponse, parseRequestBody } from '../server/utilities/http.js'
import { assertInboundRateLimit } from '../server/utilities/inboundRateLimit.js'
import { createPluginLogger } from '../server/utilities/logger.js'
import {
  parseAnalyticsInput,
  parseBatchInput,
  parseInitialSyncInput,
  parseSyncProductInput,
} from '../server/utilities/validation.js'

// Timing-safe string comparison to prevent timing attacks on API key auth
const timingSafeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    // Hash both to fixed length so we still do a constant-time comparison
    // even when lengths differ, preventing timing side-channel leaks
    const hashA = crypto.createHash('sha256').update(bufA).digest()
    const hashB = crypto.createHash('sha256').update(bufB).digest()
    // Always false for different lengths, but we must perform the comparison
    // to avoid leaking length information via timing
    void crypto.timingSafeEqual(hashA, hashB)
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}

// Service instances keyed by merchantId — supports multiple plugin instances
const serviceRegistry = new Map<string, MerchantService>()
let lastRegisteredMerchantId: null | string = null

const getService = (options: NormalizedPluginOptions, logger?: unknown): MerchantService => {
  const key = options.merchantId
  let service = serviceRegistry.get(key)
  if (!service) {
    service = createMerchantService(
      options,
      logger as {
        debug: (...args: unknown[]) => void
        error: (...args: unknown[]) => void
        warn: (...args: unknown[]) => void
      },
    )
    serviceRegistry.set(key, service)
    lastRegisteredMerchantId = key
  }
  return service
}

export const getMerchantServiceInstance = (merchantId?: string): MerchantService | null => {
  if (merchantId) {
    return serviceRegistry.get(merchantId) ?? null
  }
  // Fallback: return the last registered service (single-instance deployments)
  if (lastRegisteredMerchantId) {
    return serviceRegistry.get(lastRegisteredMerchantId) ?? null
  }
  return null
}

export const applyEndpointEnhancements = (
  config: Config,
  options: NormalizedPluginOptions,
): Config => {
  if (!config.endpoints) {
    config.endpoints = []
  }

  const basePath = options.api.basePath

  const endpoints: Endpoint[] = [
    // --- Push single product ---
    {
      handler: async (req) => {
        try {
          assertInboundRateLimit(req, options, 'push')
          await assertAccess(req, options)
          const body = await parseRequestBody(req)
          const { productId } = parseSyncProductInput(body)
          const service = getService(options, req.payload?.logger)
          const result = await service.pushProduct({ payload: req.payload, productId })
          return jsonResponse(result)
        } catch (error) {
          return errorResponse(req, error)
        }
      },
      method: 'post',
      path: `${basePath}/product/push`,
    },

    // --- Pull single product ---
    {
      handler: async (req) => {
        try {
          assertInboundRateLimit(req, options, 'pull')
          await assertAccess(req, options)
          const body = await parseRequestBody(req)
          const { productId } = parseSyncProductInput(body)
          const service = getService(options, req.payload?.logger)
          const result = await service.pullProduct({ payload: req.payload, productId })
          return jsonResponse(result)
        } catch (error) {
          return errorResponse(req, error)
        }
      },
      method: 'post',
      path: `${basePath}/product/pull`,
    },

    // --- Delete from MC ---
    {
      handler: async (req) => {
        try {
          assertInboundRateLimit(req, options, 'delete')
          await assertAccess(req, options)
          const body = await parseRequestBody(req)
          const { productId } = parseSyncProductInput(body)
          const service = getService(options, req.payload?.logger)
          const result = await service.deleteProduct({ payload: req.payload, productId })
          return jsonResponse(result)
        } catch (error) {
          return errorResponse(req, error)
        }
      },
      method: 'post',
      path: `${basePath}/product/delete`,
    },

    // --- Refresh snapshot ---
    {
      handler: async (req) => {
        try {
          assertInboundRateLimit(req, options, 'refresh')
          await assertAccess(req, options)
          const body = await parseRequestBody(req)
          const { productId } = parseSyncProductInput(body)
          const service = getService(options, req.payload?.logger)
          const result = await service.refreshSnapshot({ payload: req.payload, productId })
          return jsonResponse(result)
        } catch (error) {
          return errorResponse(req, error)
        }
      },
      method: 'post',
      path: `${basePath}/product/refresh`,
    },

    // --- Product analytics ---
    {
      handler: async (req) => {
        try {
          assertInboundRateLimit(req, options, 'analytics')
          await assertAccess(req, options)
          const body = await parseRequestBody(req)
          const { productId, rangeDays } = parseAnalyticsInput(body)
          const service = getService(options, req.payload?.logger)
          const result = await service.getProductAnalytics({
            payload: req.payload,
            productId,
            rangeDays,
          })
          return jsonResponse(result)
        } catch (error) {
          return errorResponse(req, error)
        }
      },
      method: 'post',
      path: `${basePath}/product/analytics`,
    },

    // --- Batch push ---
    {
      handler: async (req) => {
        try {
          assertInboundRateLimit(req, options, 'batch-push')
          await assertAccess(req, options)
          const body = await parseRequestBody(req)
          const { filter, productIds } = parseBatchInput(body)
          const service = getService(options, req.payload?.logger)
          const jobId = `gmc-batch-${Date.now().toString(36)}`

          let logDocId: number | string | undefined
          try {
            const logDoc = await req.payload.create({
              collection: 'gmc-sync-log' as never,
              data: {
                type: 'batch',
                failed: 0,
                jobId,
                processed: 0,
                startedAt: new Date().toISOString(),
                status: 'running',
                succeeded: 0,
                total: 0,
                triggeredBy: req.user?.email ?? 'system',
              } as never,
              overrideAccess: true,
            })
            logDocId = (logDoc as unknown as Record<string, unknown>).id as string
          } catch {
            // Non-critical
          }

          const payloadRef = req.payload
          void service.pushBatch({
            filter: filter as undefined | Where,
            onProgress: async (report) => {
              if (!logDocId) {return}
              try {
                await payloadRef.update({
                  id: logDocId,
                  collection: 'gmc-sync-log' as never,
                  data: {
                    errors: report.errors.slice(-20),
                    failed: report.failed,
                    processed: report.processed,
                    succeeded: report.succeeded,
                    total: report.total,
                  } as never,
                  overrideAccess: true,
                })
              } catch { /* best-effort */ }
            },
            payload: payloadRef,
            productIds,
          }).then(async (report) => {
            if (!logDocId) {
              void service.cleanupSyncLogs({ payload: payloadRef })
              return
            }
            try {
              await payloadRef.update({
                id: logDocId,
                collection: 'gmc-sync-log' as never,
                data: {
                  completedAt: report.completedAt,
                  errors: report.errors.slice(-50),
                  failed: report.failed,
                  processed: report.processed,
                  status: report.status,
                  succeeded: report.succeeded,
                  total: report.total,
                } as never,
                overrideAccess: true,
              })
            } catch { /* non-critical */ }
            void service.cleanupSyncLogs({ payload: payloadRef })
          }).catch((err: unknown) => {
            const log = createPluginLogger(payloadRef.logger, { operation: 'batch-async' })
            log.error('Async batch operation failed', {
              error: err instanceof Error ? err.message : String(err),
            })
          })

          return jsonResponse({ jobId, status: 'running' })
        } catch (error) {
          return errorResponse(req, error)
        }
      },
      method: 'post',
      path: `${basePath}/batch/push`,
    },

    // --- Pull all from MC ---
    {
      handler: async (req) => {
        try {
          assertInboundRateLimit(req, options, 'pull-all')
          await assertAccess(req, options)
          const service = getService(options, req.payload?.logger)
          const jobId = `gmc-pull-${Date.now().toString(36)}`

          // Create sync log immediately so UI can track progress
          let logDocId: number | string | undefined
          try {
            const logDoc = await req.payload.create({
              collection: 'gmc-sync-log' as never,
              data: {
                type: 'pullAll',
                failed: 0,
                jobId,
                processed: 0,
                startedAt: new Date().toISOString(),
                status: 'running',
                succeeded: 0,
                total: 0,
                triggeredBy: req.user?.email ?? 'system',
              } as never,
              overrideAccess: true,
            })
            logDocId = (logDoc as unknown as Record<string, unknown>).id as string
          } catch {
            // Non-critical
          }

          // Fire-and-forget the actual pull operation
          const payloadRef = req.payload
          void service.pullAllProducts({
            onProgress: async (report) => {
              if (!logDocId) {return}
              try {
                await payloadRef.update({
                  id: logDocId,
                  collection: 'gmc-sync-log' as never,
                  data: {
                    errors: report.errors.slice(-20),
                    failed: report.failed,
                    metadata: { matched: report.matched, orphaned: report.orphaned },
                    processed: report.processed,
                    succeeded: report.succeeded,
                    total: report.total,
                  } as never,
                  overrideAccess: true,
                })
              } catch {
                // Swallow — progress update is best-effort
              }
            },
            payload: payloadRef,
          }).then(async (report) => {
            if (!logDocId) {
              void service.cleanupSyncLogs({ payload: payloadRef })
              return
            }
            try {
              await payloadRef.update({
                id: logDocId,
                collection: 'gmc-sync-log' as never,
                data: {
                  completedAt: report.completedAt,
                  errors: report.errors.slice(-50),
                  failed: report.failed,
                  metadata: { matched: report.matched, orphaned: report.orphaned },
                  processed: report.processed,
                  status: report.status,
                  succeeded: report.succeeded,
                  total: report.total,
                } as never,
                overrideAccess: true,
              })
            } catch {
              // Non-critical
            }
            void service.cleanupSyncLogs({ payload: payloadRef })
          }).catch((err: unknown) => {
            const log = createPluginLogger(payloadRef.logger, { operation: 'batch-async' })
            log.error('Async batch operation failed', {
              error: err instanceof Error ? err.message : String(err),
            })
          })

          return jsonResponse({ jobId, status: 'running' })
        } catch (error) {
          return errorResponse(req, error)
        }
      },
      method: 'post',
      path: `${basePath}/batch/pull-all`,
    },

    // --- Initial sync ---
    {
      handler: async (req) => {
        try {
          assertInboundRateLimit(req, options, 'initial-sync')
          await assertAccess(req, options)
          const body = await parseRequestBody(req)
          const overrides = parseInitialSyncInput(body)
          const service = getService(options, req.payload?.logger)
          const jobId = `gmc-isync-${Date.now().toString(36)}`

          let logDocId: number | string | undefined
          try {
            const logDoc = await req.payload.create({
              collection: 'gmc-sync-log' as never,
              data: {
                type: 'initialSync',
                failed: 0,
                jobId,
                metadata: { dryRun: overrides.dryRun },
                processed: 0,
                startedAt: new Date().toISOString(),
                status: 'running',
                succeeded: 0,
                total: 0,
                triggeredBy: req.user?.email ?? 'system',
              } as never,
              overrideAccess: true,
            })
            logDocId = (logDoc as unknown as Record<string, unknown>).id as string
          } catch {
            // Non-critical
          }

          const payloadRef = req.payload
          void service.runInitialSync({
            onProgress: async (report) => {
              if (!logDocId) {return}
              try {
                await payloadRef.update({
                  id: logDocId,
                  collection: 'gmc-sync-log' as never,
                  data: {
                    errors: report.errors.slice(-20),
                    failed: report.failed,
                    processed: report.processed,
                    succeeded: report.succeeded,
                    total: report.total,
                  } as never,
                  overrideAccess: true,
                })
              } catch { /* best-effort */ }
            },
            overrides,
            payload: payloadRef,
          }).then(async (report) => {
            if (!logDocId) {
              void service.cleanupSyncLogs({ payload: payloadRef })
              return
            }
            try {
              await payloadRef.update({
                id: logDocId,
                collection: 'gmc-sync-log' as never,
                data: {
                  completedAt: report.completedAt,
                  errors: report.errors.slice(-50),
                  failed: report.failed,
                  metadata: {
                    dryRun: report.dryRun,
                    existingRemote: report.existingRemote,
                    skipped: report.skipped,
                  },
                  processed: report.processed,
                  status: report.status,
                  succeeded: report.succeeded,
                  total: report.total,
                } as never,
                overrideAccess: true,
              })
            } catch { /* non-critical */ }
            void service.cleanupSyncLogs({ payload: payloadRef })
          }).catch((err: unknown) => {
            const log = createPluginLogger(payloadRef.logger, { operation: 'batch-async' })
            log.error('Async batch operation failed', {
              error: err instanceof Error ? err.message : String(err),
            })
          })

          return jsonResponse({ jobId, status: 'running' })
        } catch (error) {
          return errorResponse(req, error)
        }
      },
      method: 'post',
      path: `${basePath}/batch/initial-sync`,
    },

    // --- Batch push dirty only ---
    {
      handler: async (req) => {
        try {
          assertInboundRateLimit(req, options, 'batch-push')
          await assertAccess(req, options)
          const service = getService(options, req.payload?.logger)
          const jobId = `gmc-batch-dirty-${Date.now().toString(36)}`

          let logDocId: number | string | undefined
          try {
            const logDoc = await req.payload.create({
              collection: 'gmc-sync-log' as never,
              data: {
                type: 'batch',
                failed: 0,
                jobId,
                processed: 0,
                startedAt: new Date().toISOString(),
                status: 'running',
                succeeded: 0,
                total: 0,
                triggeredBy: req.user?.email ?? 'system',
              } as never,
              overrideAccess: true,
            })
            logDocId = (logDoc as unknown as Record<string, unknown>).id as string
          } catch {
            // Non-critical
          }

          const payloadRef = req.payload
          void service.pushBatch({
            filter: { 'merchantCenter.syncMeta.dirty': { equals: true } } as Where,
            onProgress: async (report) => {
              if (!logDocId) {return}
              try {
                await payloadRef.update({
                  id: logDocId,
                  collection: 'gmc-sync-log' as never,
                  data: {
                    errors: report.errors.slice(-20),
                    failed: report.failed,
                    processed: report.processed,
                    succeeded: report.succeeded,
                    total: report.total,
                  } as never,
                  overrideAccess: true,
                })
              } catch { /* best-effort */ }
            },
            payload: payloadRef,
          }).then(async (report) => {
            if (!logDocId) {
              void service.cleanupSyncLogs({ payload: payloadRef })
              return
            }
            try {
              await payloadRef.update({
                id: logDocId,
                collection: 'gmc-sync-log' as never,
                data: {
                  completedAt: report.completedAt,
                  errors: report.errors.slice(-50),
                  failed: report.failed,
                  processed: report.processed,
                  status: report.status,
                  succeeded: report.succeeded,
                  total: report.total,
                } as never,
                overrideAccess: true,
              })
            } catch { /* non-critical */ }
            void service.cleanupSyncLogs({ payload: payloadRef })
          }).catch((err: unknown) => {
            const log = createPluginLogger(payloadRef.logger, { operation: 'batch-async' })
            log.error('Async batch operation failed', {
              error: err instanceof Error ? err.message : String(err),
            })
          })

          return jsonResponse({ jobId, status: 'running' })
        } catch (error) {
          return errorResponse(req, error)
        }
      },
      method: 'post',
      path: `${basePath}/batch/push-dirty`,
    },

    // --- Field mappings (GET) ---
    {
      handler: async (req) => {
        try {
          await assertAccess(req, options)
          const result = await req.payload.find({
            collection: 'gmc-field-mappings' as never,
            depth: 0,
            limit: 100,
            sort: 'order',
          })
          return jsonResponse({ mappings: result.docs })
        } catch (error) {
          return errorResponse(req, error)
        }
      },
      method: 'get',
      path: `${basePath}/mappings`,
    },

    // --- Field mappings (POST — save) ---
    {
      handler: async (req) => {
        try {
          await assertAccess(req, options)
          const body = await parseRequestBody(req)
          const mappings = body.mappings as Array<Record<string, unknown>>

          if (!Array.isArray(mappings)) {
            return jsonResponse({ error: 'mappings must be an array' }, 400)
          }

          // Snapshot existing mappings before mutation
          const existing = await req.payload.find({
            collection: 'gmc-field-mappings' as never,
            depth: 0,
            limit: 100,
          })
          const oldIds = existing.docs.map(
            (doc) => (doc as unknown as Record<string, unknown>).id as string,
          )

          // Create new mappings first — if this fails, old mappings remain intact
          for (const mapping of mappings) {
            await req.payload.create({
              collection: 'gmc-field-mappings' as never,
              data: mapping as never,
              overrideAccess: true,
            })
          }

          // Only delete old mappings after all new ones are successfully created
          for (const id of oldIds) {
            await req.payload.delete({
              id,
              collection: 'gmc-field-mappings' as never,
              overrideAccess: true,
            })
          }

          return jsonResponse({ saved: mappings.length })
        } catch (error) {
          return errorResponse(req, error)
        }
      },
      method: 'post',
      path: `${basePath}/mappings`,
    },

    // --- Health check ---
    {
      handler: async (req) => {
        try {
          const service = getService(options, req.payload?.logger)
          const url = new URL(req.url || '', 'http://localhost')
          const deep = url.searchParams.get('deep') === 'true'
          if (deep) {
            // Deep health check makes API calls — require authentication
            await assertAccess(req, options)
            const result = await service.getHealthDeep({ payload: req.payload })
            return jsonResponse(result)
          }
          return jsonResponse(service.getHealth())
        } catch (error) {
          return errorResponse(req, error)
        }
      },
      method: 'get',
      path: `${basePath}/health`,
    },

    // --- Cron sync endpoint (for external schedulers: EventBridge, Lambda, GitHub Actions, etc.) ---
    {
      handler: async (req) => {
        try {
          // Authenticate via API key (not user session — cron jobs have no session)
          const url = new URL(req.url || '', 'http://localhost')
          const key = url.searchParams.get('key') ?? req.headers.get('x-gmc-api-key')

          if (!options.sync.schedule.apiKey) {
            return jsonResponse(
              { error: 'Cron endpoint not configured. Set sync.schedule.apiKey in plugin options.' },
              403,
            )
          }

          if (!key || !timingSafeEqual(key, options.sync.schedule.apiKey)) {
            return jsonResponse({ error: 'Invalid or missing API key' }, 401)
          }

          const service = getService(options, req.payload?.logger)
          const jobId = `gmc-cron-${Date.now().toString(36)}`

          let logDocId: number | string | undefined
          try {
            const logDoc = await req.payload.create({
              collection: 'gmc-sync-log' as never,
              data: {
                type: 'batch',
                failed: 0,
                jobId,
                metadata: { trigger: 'cron-external' },
                processed: 0,
                startedAt: new Date().toISOString(),
                status: 'running',
                succeeded: 0,
                total: 0,
                triggeredBy: 'cron',
              } as never,
              overrideAccess: true,
            })
            logDocId = (logDoc as unknown as Record<string, unknown>).id as string
          } catch {
            // Non-critical
          }

          const payloadRef = req.payload
          void service.pushBatch({
            filter: { 'merchantCenter.syncMeta.dirty': { equals: true } } as Where,
            onProgress: async (report) => {
              if (!logDocId) {return}
              try {
                await payloadRef.update({
                  id: logDocId,
                  collection: 'gmc-sync-log' as never,
                  data: {
                    errors: report.errors.slice(-20),
                    failed: report.failed,
                    processed: report.processed,
                    succeeded: report.succeeded,
                    total: report.total,
                  } as never,
                  overrideAccess: true,
                })
              } catch { /* best-effort */ }
            },
            payload: payloadRef,
          }).then(async (report) => {
            if (!logDocId) {
              void service.cleanupSyncLogs({ payload: payloadRef })
              return
            }
            try {
              await payloadRef.update({
                id: logDocId,
                collection: 'gmc-sync-log' as never,
                data: {
                  completedAt: report.completedAt,
                  errors: report.errors.slice(-50),
                  failed: report.failed,
                  processed: report.processed,
                  status: report.status,
                  succeeded: report.succeeded,
                  total: report.total,
                } as never,
                overrideAccess: true,
              })
            } catch { /* non-critical */ }
            void service.cleanupSyncLogs({ payload: payloadRef })
          }).catch((err: unknown) => {
            const log = createPluginLogger(payloadRef.logger, { operation: 'batch-async' })
            log.error('Async batch operation failed', {
              error: err instanceof Error ? err.message : String(err),
            })
          })

          return jsonResponse({ jobId, status: 'running' })
        } catch (error) {
          return errorResponse(req, error)
        }
      },
      method: 'post',
      path: `${basePath}/cron/sync`,
    },
  ]

  config.endpoints.push(...endpoints)

  return config
}
