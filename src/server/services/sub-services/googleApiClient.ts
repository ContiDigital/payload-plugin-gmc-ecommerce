import type { Payload } from 'payload'

import type { CredentialResolution, GetCredentialsFn } from '../../../types/index.js'

import { GOOGLE_AUTH_SCOPES, MERCHANT_API_BASE_URL } from '../../../v2/runtimeConstants.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AccessTokenEntry = {
  expiresAt: number
  token: string
}

type RequestOptions = {
  body?: Record<string, unknown>
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST'
  params?: Record<string, string>
  path: string
  subApi?: string
  timeoutMs?: number
}

export type GoogleApiResponse<T = unknown> = {
  data: T
  status: number
}

type MerchantErrorInfo = {
  apiMessage?: string
  fieldLocation?: string
  reason?: string
}

const merchantErrorInfoFrom = (value: unknown): MerchantErrorInfo => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const root = value as Record<string, unknown>
  if (!root.error || typeof root.error !== 'object' || Array.isArray(root.error)) {
    return {}
  }
  const error = root.error as Record<string, unknown>
  const clean = (candidate: unknown, maxLength: number): string | undefined => {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > maxLength) {
      return undefined
    }
    return [...candidate].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
      ? undefined
      : candidate
  }
  const apiMessage = clean(error.message, 4_000)
  const details = Array.isArray(error.details) ? error.details : []
  const info = details.find((candidate): candidate is Record<string, unknown> =>
    Boolean(
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>)['@type'] ===
        'type.googleapis.com/google.rpc.ErrorInfo',
    ),
  )
  const metadata =
    info?.metadata && typeof info.metadata === 'object' && !Array.isArray(info.metadata)
      ? (info.metadata as Record<string, unknown>)
      : undefined
  const rawReason = clean(metadata?.REASON, 128)
  const reason = rawReason && /^[A-Z][A-Z0-9_]*$/.test(rawReason) ? rawReason : undefined
  const fieldLocation = clean(metadata?.FIELD_LOCATION, 512)
  return { apiMessage, fieldLocation, reason }
}

export class GoogleApiError extends Error {
  public readonly apiMessage?: string
  public readonly fieldLocation?: string
  public readonly reason?: string
  public readonly responseBody?: unknown
  public readonly retryAfterMs?: number
  public readonly statusCode: number

  constructor(message: string, statusCode: number, responseBody?: unknown, retryAfterMs?: number) {
    super(message)
    this.name = 'GoogleApiError'
    this.statusCode = statusCode
    this.responseBody = responseBody
    this.retryAfterMs = retryAfterMs
    const info = merchantErrorInfoFrom(responseBody)
    this.apiMessage = info.apiMessage
    this.fieldLocation = info.fieldLocation
    this.reason = info.reason
  }
}

/**
 * A request could not reach Google or its response stream failed in transit.
 * Keep this distinct from JavaScript TypeError because v2 deliberately treats
 * validation/configuration TypeErrors as terminal durable failures.
 */
export class GoogleTransportError extends Error {
  public readonly code = 'GMC_GOOGLE_TRANSPORT'

  constructor(message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'GoogleTransportError'
  }
}

const MAX_MERCHANT_RESPONSE_BYTES = 64 * 1024 * 1024
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024
const MAX_ACCESS_TOKEN_LENGTH = 64 * 1024
const MAX_TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024
const MAX_PRIVATE_KEY_BYTES = 1024 * 1024
const MAX_CLIENT_EMAIL_LENGTH = 320

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })

const retryAfterMsFrom = (response: Response): number | undefined => {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) {
    return undefined
  }
  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1_000
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
  }
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) {
    return undefined
  }
  return Math.max(0, timestamp - Date.now())
}

const readBoundedResponseText = async (
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> => {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength) {
    const parsedLength = Number(declaredLength)
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      await response.body?.cancel()
      throw new RangeError(`${label} exceeds its ${maxBytes} byte response limit`)
    }
  }
  if (!response.body) {
    return ''
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new RangeError(`${label} exceeds its ${maxBytes} byte response limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

const fetchGoogle = async (
  input: string,
  init: RequestInit,
  operation: string,
): Promise<Response> => {
  try {
    return await fetch(input, init)
  } catch (error) {
    throw new GoogleTransportError(`${operation} transport failed`, error)
  }
}

const readGoogleResponseText = async (
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> => {
  try {
    return await readBoundedResponseText(response, maxBytes, label)
  } catch (error) {
    if (error instanceof RangeError) {
      throw error
    }
    throw new GoogleTransportError(`${label} stream failed`, error)
  }
}

// ---------------------------------------------------------------------------
// Access token exchange (stateless — cache is managed per-client instance)
// ---------------------------------------------------------------------------

const exchangeForAccessToken = async (
  credentialResolution: CredentialResolution,
  timeoutMs: number,
): Promise<{ access_token: string; expires_in: number }> => {
  let clientEmail: string
  let privateKey: string

  if (credentialResolution.type === 'keyFilename') {
    const fs = await import('fs/promises')
    if (
      typeof credentialResolution.path !== 'string' ||
      !credentialResolution.path.trim() ||
      credentialResolution.path.length > 4_096
    ) {
      throw new TypeError('Google service-account credential path is invalid')
    }
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(credentialResolution.path)
    } catch (error) {
      throw new TypeError('Google service-account credential file cannot be read', {
        cause: error,
      })
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CREDENTIAL_FILE_BYTES) {
      throw new TypeError(
        `Google service-account credential file must contain 1-${MAX_CREDENTIAL_FILE_BYTES} bytes`,
      )
    }
    let raw: string
    try {
      raw = await fs.readFile(credentialResolution.path, 'utf-8')
    } catch (error) {
      throw new TypeError('Google service-account credential file cannot be read', {
        cause: error,
      })
    }
    let json: Record<string, unknown>
    try {
      json = JSON.parse(raw) as Record<string, unknown>
    } catch (error) {
      throw new TypeError('Google service-account credential file contains malformed JSON', {
        cause: error,
      })
    }
    clientEmail = typeof json.client_email === 'string' ? json.client_email : ''
    privateKey = typeof json.private_key === 'string' ? json.private_key : ''
  } else if (credentialResolution.type === 'json') {
    clientEmail = credentialResolution.credentials.client_email
    privateKey = credentialResolution.credentials.private_key
  } else {
    throw new TypeError('Google service-account credential resolution is invalid')
  }
  if (
    !clientEmail.trim() ||
    clientEmail !== clientEmail.trim() ||
    clientEmail.length > MAX_CLIENT_EMAIL_LENGTH ||
    hasControlCharacters(clientEmail) ||
    !privateKey.trim() ||
    Buffer.byteLength(privateKey, 'utf8') > MAX_PRIVATE_KEY_BYTES
  ) {
    throw new TypeError('Google service-account credentials are incomplete')
  }

  const now = Math.floor(Date.now() / 1000)
  const expiry = now + 3600

  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64UrlEncode(
    JSON.stringify({
      aud: 'https://oauth2.googleapis.com/token',
      exp: expiry,
      iat: now,
      iss: clientEmail,
      scope: GOOGLE_AUTH_SCOPES.join(' '),
    }),
  )

  const signingInput = `${header}.${payload}`
  const signature = await signRS256(signingInput, privateKey)
  const jwt = `${signingInput}.${signature}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchGoogle(
      'https://oauth2.googleapis.com/token',
      {
        body: new URLSearchParams({
          assertion: jwt,
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        method: 'POST',
        signal: controller.signal,
      },
      'Google OAuth token exchange',
    )
    const text = await readGoogleResponseText(
      response,
      MAX_OAUTH_RESPONSE_BYTES,
      'Google OAuth response',
    )
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    if (!response.ok) {
      throw new GoogleApiError(
        'Google OAuth token exchange failed',
        response.status,
        body,
        retryAfterMsFrom(response),
      )
    }
    const record = body as Record<string, unknown> | undefined
    if (
      !record ||
      typeof record.access_token !== 'string' ||
      record.access_token.trim().length === 0 ||
      record.access_token !== record.access_token.trim() ||
      record.access_token.length > MAX_ACCESS_TOKEN_LENGTH ||
      hasControlCharacters(record.access_token) ||
      typeof record.expires_in !== 'number' ||
      !Number.isSafeInteger(record.expires_in) ||
      record.expires_in <= 0 ||
      record.expires_in > MAX_TOKEN_LIFETIME_SECONDS
    ) {
      throw new TypeError('Google OAuth token response is malformed')
    }
    return body as { access_token: string; expires_in: number }
  } finally {
    clearTimeout(timeoutId)
  }
}

// ---------------------------------------------------------------------------
// JWT signing utilities (native Node.js crypto)
// ---------------------------------------------------------------------------

const base64UrlEncode = (input: string): string => {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

const signRS256 = async (input: string, privateKeyPem: string): Promise<string> => {
  const crypto = await import('crypto')
  let privateKey: ReturnType<typeof crypto.createPrivateKey>
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem)
  } catch (error) {
    throw new TypeError('Google service-account private key is invalid', { cause: error })
  }
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new TypeError('Google service-account private key must be RSA')
  }
  try {
    const sign = crypto.createSign('RSA-SHA256')
    sign.update(input)
    const signature = sign.sign(privateKey, 'base64')
    return signature.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  } catch (error) {
    throw new TypeError('Google service-account private key is invalid', { cause: error })
  }
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export type GoogleApiClientOptions = {
  dataSourceName: string
  getCredentials: GetCredentialsFn
  merchantId: string
  rateLimit: { requestTimeoutMs: number }
}

export const createGoogleApiClient = (options: GoogleApiClientOptions) => {
  // Per-instance token cache — not shared across client instances
  let cachedToken: AccessTokenEntry | null = null
  let tokenExchange: null | Promise<string> = null

  const getAccessToken = async (payload: null | Payload): Promise<string> => {
    if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
      return cachedToken.token
    }
    if (tokenExchange) {
      return tokenExchange
    }

    tokenExchange = (async () => {
      const credentials = await options.getCredentials({ payload })
      const data = await exchangeForAccessToken(credentials, options.rateLimit.requestTimeoutMs)

      cachedToken = {
        expiresAt: Date.now() + data.expires_in * 1000,
        token: data.access_token,
      }

      return data.access_token
    })()
    try {
      return await tokenExchange
    } finally {
      tokenExchange = null
    }
  }

  const request = async <T = unknown>(
    requestOptions: RequestOptions,
    payload: null | Payload,
  ): Promise<GoogleApiResponse<T>> => {
    const subApi = requestOptions.subApi ?? 'products'
    const baseUrl = `${MERCHANT_API_BASE_URL}/${subApi}/v1`

    let url = `${baseUrl}/${requestOptions.path}`

    if (requestOptions.params && Object.keys(requestOptions.params).length > 0) {
      const searchParams = new URLSearchParams(requestOptions.params)
      url = `${url}?${searchParams.toString()}`
    }

    const send = async (token: string): Promise<GoogleApiResponse<T>> => {
      const controller = new AbortController()
      const timeoutMs = requestOptions.timeoutMs ?? options.rateLimit.requestTimeoutMs
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetchGoogle(
          url,
          {
            body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            method: requestOptions.method,
            signal: controller.signal,
          },
          `Merchant API ${requestOptions.method} ${requestOptions.path}`,
        )

        if (response.status === 204 || response.headers.get('content-length') === '0') {
          if (!response.ok) {
            throw new GoogleApiError(
              `Merchant API ${requestOptions.method} ${requestOptions.path} failed with status ${response.status}`,
              response.status,
              undefined,
              retryAfterMsFrom(response),
            )
          }
          return { data: undefined as T, status: response.status }
        }

        const responseText = await readGoogleResponseText(
          response,
          MAX_MERCHANT_RESPONSE_BYTES,
          'Merchant API response',
        )
        let responseBody: unknown
        try {
          responseBody = responseText ? JSON.parse(responseText) : undefined
        } catch {
          responseBody = responseText
        }

        if (!response.ok) {
          throw new GoogleApiError(
            `Merchant API ${requestOptions.method} ${requestOptions.path} failed with status ${response.status}`,
            response.status,
            responseBody,
            retryAfterMsFrom(response),
          )
        }

        return { data: responseBody as T, status: response.status }
      } finally {
        clearTimeout(timeoutId)
      }
    }

    const token = await getAccessToken(payload)
    try {
      return await send(token)
    } catch (error) {
      if (!(error instanceof GoogleApiError) || error.statusCode !== 401) {
        throw error
      }
      // A token may be revoked before its advertised expiry. Invalidate only
      // the token that failed (another concurrent request may already have
      // refreshed it), coalesce the replacement exchange, and retry once.
      if (cachedToken?.token === token) {
        cachedToken = null
      }
      // Do not retry inside the HTTP client: the executor's outer Merchant
      // boundary must reserve a separate local/distributed quota slot for the
      // replacement physical request. The next invocation obtains a fresh
      // token because the rejected cache entry was invalidated above.
      throw error
    }
  }

  // -----------------------------------------------------------------------
  // High-level methods
  // -----------------------------------------------------------------------

  const insertProductInput = async (
    input: Record<string, unknown>,
    payload: null | Payload,
    dataSourceOverride?: string,
  ) => {
    const dataSource = dataSourceOverride ?? options.dataSourceName
    return request<Record<string, unknown>>(
      {
        body: input,
        method: 'POST',
        params: { dataSource },
        path: `accounts/${options.merchantId}/productInputs:insert`,
      },
      payload,
    )
  }

  const deleteProductInput = async (
    productInputName: string,
    payload: null | Payload,
    dataSourceOverride?: string,
  ) => {
    const dataSource = dataSourceOverride ?? options.dataSourceName
    return request<void>(
      {
        method: 'DELETE',
        params: { dataSource },
        path: productInputName,
      },
      payload,
    )
  }

  const getProduct = async (productName: string, payload: null | Payload) => {
    return request<Record<string, unknown>>(
      {
        method: 'GET',
        path: productName,
      },
      payload,
    )
  }

  const getDataSource = async (dataSourceName: string, payload: null | Payload) => {
    return request<Record<string, unknown>>(
      {
        method: 'GET',
        path: dataSourceName,
        subApi: 'datasources',
      },
      payload,
    )
  }

  const listProducts = async (payload: null | Payload, pageSize = 250, pageToken?: string) => {
    const params: Record<string, string> = { pageSize: String(pageSize) }
    if (pageToken) {
      params.pageToken = pageToken
    }

    return request<{ nextPageToken?: string; products?: Record<string, unknown>[] }>(
      {
        method: 'GET',
        params,
        path: `accounts/${options.merchantId}/products`,
      },
      payload,
    )
  }

  const reportQuery = async (query: string, payload: null | Payload) => {
    return request<{ results?: Record<string, unknown>[] }>(
      {
        body: { query },
        method: 'POST',
        path: `accounts/${options.merchantId}/reports:search`,
        subApi: 'reports',
      },
      payload,
    )
  }

  // -----------------------------------------------------------------------
  // Local Inventory methods (Inventories sub-API)
  // -----------------------------------------------------------------------

  const insertLocalInventory = async (
    productName: string,
    localInventory: Record<string, unknown>,
    payload: null | Payload,
  ) => {
    return request<Record<string, unknown>>(
      {
        body: localInventory,
        method: 'POST',
        path: `${productName}/localInventories:insert`,
        subApi: 'inventories',
      },
      payload,
    )
  }

  const deleteLocalInventory = async (
    productName: string,
    storeCode: string,
    payload: null | Payload,
  ) => {
    return request<void>(
      {
        method: 'DELETE',
        path: `${productName}/localInventories/${storeCode}`,
        subApi: 'inventories',
      },
      payload,
    )
  }

  const listLocalInventories = async (
    productName: string,
    payload: null | Payload,
    pageSize = 250,
  ) => {
    return request<{ localInventories?: Record<string, unknown>[]; nextPageToken?: string }>(
      {
        method: 'GET',
        params: { pageSize: String(pageSize) },
        path: `${productName}/localInventories`,
        subApi: 'inventories',
      },
      payload,
    )
  }

  const resetTokenCache = (): void => {
    cachedToken = null
    tokenExchange = null
  }

  return {
    deleteLocalInventory,
    deleteProductInput,
    getDataSource,
    getProduct,
    insertLocalInventory,
    insertProductInput,
    listLocalInventories,
    listProducts,
    reportQuery,
    request,
    resetTokenCache,
  }
}

export type GoogleApiClient = ReturnType<typeof createGoogleApiClient>
