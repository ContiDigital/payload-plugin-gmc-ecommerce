import { describe, expect, it } from 'vitest'

import {
  GoogleApiError,
  GoogleTransportError,
} from '../../server/services/sub-services/googleApiClient.js'
import {
  GmcAsyncIdempotencyConflictError,
  GmcAsyncWorkflowConflictError,
} from '../async.js'
import {
  GmcApiPrimaryDataSourceRequiredError,
  GmcProcessedProductNotReadyError,
  GmcProductDataSourceConflictError,
} from '../dataSource.js'
import { classifyGmcCommandError } from '../errors.js'
import { GmcFeedLimitError } from '../feed/limits.js'
import { GmcLocalInventorySourceVersionConflictError } from '../state/localInventoryPayloadStateStore.js'
import { GmcIdentityOwnershipError } from '../state/payloadStateStore.js'

describe('GMC durable error classification', () => {
  it('marks validation and explicit configuration failures terminal', () => {
    expect(classifyGmcCommandError(new TypeError('invalid projection'))).toMatchObject({
      message: 'invalid projection',
      retryable: false,
    })
    expect(
      classifyGmcCommandError(new GmcApiPrimaryDataSourceRequiredError('wrong source')),
    ).toEqual({
      code: 'GMC_API_PRIMARY_DATA_SOURCE_REQUIRED',
      message: 'wrong source',
      retryable: false,
    })
    expect(
      classifyGmcCommandError(
        new GmcProductDataSourceConflictError({
          actualDataSourceName: 'accounts/1/dataSources/2',
          expectedDataSourceName: 'accounts/1/dataSources/3',
        }),
      ),
    ).toMatchObject({ code: 'GMC_PRODUCT_DATA_SOURCE_CONFLICT', retryable: false })
    expect(
      classifyGmcCommandError(new GmcAsyncIdempotencyConflictError('duplicate-key')),
    ).toMatchObject({ code: 'GMC_ASYNC_IDEMPOTENCY_CONFLICT', retryable: false })
    expect(
      classifyGmcCommandError(new GmcAsyncWorkflowConflictError('active-operation')),
    ).toMatchObject({ code: 'GMC_ASYNC_WORKFLOW_CONFLICT', retryable: false })
    expect(classifyGmcCommandError(new GmcFeedLimitError('feed too large'))).toEqual({
      code: 'GMC_FEED_LIMIT_EXCEEDED',
      message: 'feed too large',
      retryable: false,
    })
    expect(classifyGmcCommandError(new RangeError('response too large')).retryable).toBe(false)
    expect(classifyGmcCommandError(new SyntaxError('malformed JSON')).retryable).toBe(false)
    expect(
      classifyGmcCommandError(
        new GmcIdentityOwnershipError({
          existingProductId: 'product-1',
          identityKey: 'en/US/sku-1',
          productId: 'product-2',
        }),
      ),
    ).toMatchObject({ code: 'GMC_IDENTITY_OWNERSHIP_CONFLICT', retryable: false })
    expect(
      classifyGmcCommandError(
        new GmcLocalInventorySourceVersionConflictError({
          key: 'local-key',
          sourceVersion: '42',
        }),
      ),
    ).toMatchObject({
      code: 'GMC_LOCAL_INVENTORY_SOURCE_VERSION_CONFLICT',
      retryable: false,
    })
  })

  it('retries only transient Google responses and unknown infrastructure errors', () => {
    expect(classifyGmcCommandError(new GoogleApiError('busy', 503)).retryable).toBe(true)
    expect(classifyGmcCommandError(new GoogleApiError('quota', 429)).retryable).toBe(true)
    expect(classifyGmcCommandError(new GoogleApiError('denied', 403))).toMatchObject({
      code: 'HTTP_403',
      retryable: false,
    })
    expect(
      classifyGmcCommandError(
        new GoogleApiError('merchant request failed', 400, {
          error: {
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                metadata: {
                  FIELD_LOCATION: 'productInput',
                  REASON: 'CONFLICT_CONCURRENT_MODIFICATION',
                },
              },
            ],
            message: 'A concurrent modification was detected.',
          },
        }),
      ),
    ).toEqual({
      code: 'GOOGLE_CONFLICT_CONCURRENT_MODIFICATION',
      message: 'merchant request failed: A concurrent modification was detected.',
      retryable: true,
    })
    expect(
      classifyGmcCommandError(
        new GoogleApiError('merchant request failed', 429, {
          error: {
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                metadata: { REASON: 'QUOTA_TOO_MANY_REQUESTS' },
              },
            ],
            message: 'Daily request quota exceeded.',
          },
        }),
      ),
    ).toMatchObject({ code: 'GOOGLE_QUOTA_TOO_MANY_REQUESTS', retryable: false })
    expect(classifyGmcCommandError(new Error('socket closed')).retryable).toBe(true)
    expect(
      classifyGmcCommandError(
        new GoogleTransportError('Merchant API transport failed', new TypeError('fetch failed')),
      ),
    ).toEqual({
      code: 'GMC_GOOGLE_TRANSPORT',
      message: 'Merchant API transport failed',
      retryable: true,
    })
    expect(
      classifyGmcCommandError(
        new GmcProcessedProductNotReadyError({
          contentLanguage: 'en',
          feedLabel: 'US',
          offerId: 'sku-1',
        }),
      ),
    ).toMatchObject({
      code: 'GMC_PROCESSED_PRODUCT_NOT_READY',
      retryable: true,
    })
  })
})
