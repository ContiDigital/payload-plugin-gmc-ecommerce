import {
  GoogleApiError,
  GoogleTransportError,
} from '../server/services/sub-services/googleApiClient.js'
import {
  GmcAsyncIdempotencyConflictError,
  GmcAsyncWorkflowConflictError,
} from './async.js'
import { isRetryableMerchantApiError } from './runtimeConstants.js'
import { GmcIdentityOwnershipError } from './state/payloadStateStore.js'

export type GmcCommandErrorClassification = {
  code?: string
  message: string
  retryable: boolean
}

/**
 * Classify a failed executor attempt for durable host adapters.
 *
 * Unknown/infrastructure failures remain retryable. Invalid plugin input,
 * invariant violations, and non-transient Google responses are terminal so a
 * durable worker can fail the operation once instead of exhausting its queue.
 */
export const classifyGmcCommandError = (error: unknown): GmcCommandErrorClassification => {
  const status = error instanceof GoogleApiError ? error.statusCode : undefined
  const merchantReason = error instanceof GoogleApiError ? error.reason : undefined
  const explicitCode =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined
  const rawMessage = error instanceof Error ? error.message : String(error)
  const message =
    error instanceof GoogleApiError && error.apiMessage
      ? `${rawMessage}: ${error.apiMessage}`
      : rawMessage
  const deterministicFailure =
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof SyntaxError ||
    error instanceof GmcAsyncIdempotencyConflictError ||
    error instanceof GmcAsyncWorkflowConflictError ||
    error instanceof GmcIdentityOwnershipError

  return {
    code:
      merchantReason !== undefined
        ? `GOOGLE_${merchantReason}`
        : status === undefined
          ? explicitCode
          : `HTTP_${status}`,
    message: message.slice(0, 4_000) || 'Merchant operation failed without an error message',
    retryable:
      error instanceof GoogleTransportError
        ? true
        : status === undefined
          ? !deterministicFailure
          : isRetryableMerchantApiError({ reason: merchantReason, statusCode: status }),
  }
}
