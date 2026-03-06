import type { Payload } from 'payload'

import type { CredentialResolution, NormalizedPluginOptions } from '../../../types/index.js'

import { GOOGLE_AUTH_SCOPES, MERCHANT_API_BASE_URL } from '../../../constants.js'

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

export class GoogleApiError extends Error {
  public readonly responseBody?: unknown
  public readonly statusCode: number

  constructor(message: string, statusCode: number, responseBody?: unknown) {
    super(message)
    this.name = 'GoogleApiError'
    this.statusCode = statusCode
    this.responseBody = responseBody
  }
}

// ---------------------------------------------------------------------------
// Access token exchange (stateless — cache is managed per-client instance)
// ---------------------------------------------------------------------------

const exchangeForAccessToken = async (
  credentialResolution: CredentialResolution,
): Promise<{ access_token: string; expires_in: number }> => {
  let clientEmail: string
  let privateKey: string

  if (credentialResolution.type === 'keyFilename') {
    const fs = await import('fs/promises')
    const raw = await fs.readFile(credentialResolution.path, 'utf-8')
    const json = JSON.parse(raw)
    clientEmail = json.client_email
    privateKey = json.private_key
  } else {
    clientEmail = credentialResolution.credentials.client_email
    privateKey = credentialResolution.credentials.private_key
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

  const response = await fetch('https://oauth2.googleapis.com/token', {
    body: new URLSearchParams({
      assertion: jwt,
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to obtain access token: ${response.status} ${text}`)
  }

  return (await response.json()) as { access_token: string; expires_in: number }
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
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(input)
  const signature = sign.sign(privateKeyPem, 'base64')
  return signature.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export const createGoogleApiClient = (options: NormalizedPluginOptions) => {
  // Per-instance token cache — not shared across client instances
  let cachedToken: AccessTokenEntry | null = null

  const getAccessToken = async (payload: null | Payload): Promise<string> => {
    if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
      return cachedToken.token
    }

    const credentials = await options.getCredentials({ payload })
    const data = await exchangeForAccessToken(credentials)

    cachedToken = {
      expiresAt: Date.now() + data.expires_in * 1000,
      token: data.access_token,
    }

    return data.access_token
  }

  const request = async <T = unknown>(
    requestOptions: RequestOptions,
    payload: null | Payload,
  ): Promise<GoogleApiResponse<T>> => {
    const token = await getAccessToken(payload)
    const subApi = requestOptions.subApi ?? 'products'
    const baseUrl = `${MERCHANT_API_BASE_URL}/${subApi}/v1`

    let url = `${baseUrl}/${requestOptions.path}`

    if (requestOptions.params && Object.keys(requestOptions.params).length > 0) {
      const searchParams = new URLSearchParams(requestOptions.params)
      url = `${url}?${searchParams.toString()}`
    }

    const controller = new AbortController()
    const timeoutMs = requestOptions.timeoutMs ?? options.rateLimit.requestTimeoutMs
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        method: requestOptions.method,
        signal: controller.signal,
      })

      if (response.status === 204 || response.headers.get('content-length') === '0') {
        return { data: undefined as T, status: response.status }
      }

      const responseBody = await response.json()

      if (!response.ok) {
        throw new GoogleApiError(
          `Merchant API ${requestOptions.method} ${requestOptions.path} failed with status ${response.status}`,
          response.status,
          responseBody,
        )
      }

      return { data: responseBody as T, status: response.status }
    } finally {
      clearTimeout(timeoutId)
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

  const listProducts = async (
    payload: null | Payload,
    pageSize = 250,
    pageToken?: string,
  ) => {
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

  const reportQuery = async (
    query: string,
    payload: null | Payload,
  ) => {
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

  const resetTokenCache = (): void => {
    cachedToken = null
  }

  return {
    deleteProductInput,
    getProduct,
    insertProductInput,
    listProducts,
    reportQuery,
    request,
    resetTokenCache,
  }
}

export type GoogleApiClient = ReturnType<typeof createGoogleApiClient>
