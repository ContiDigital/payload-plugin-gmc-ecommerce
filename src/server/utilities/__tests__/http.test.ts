import { describe, expect, test, vi } from 'vitest'

import { errorResponse, parseRequestBody } from '../http.js'
import { ValidationError } from '../httpError.js'

describe('parseRequestBody', () => {
  test('returns req.data when Payload already parsed a body object', async () => {
    await expect(parseRequestBody({
      data: { productId: '123' },
    } as never)).resolves.toEqual({ productId: '123' })
  })

  test('parses JSON from req.json()', async () => {
    await expect(parseRequestBody({
      json: () => Promise.resolve({ productId: '456' }),
    } as never)).resolves.toEqual({ productId: '456' })
  })

  test('throws when the request body is malformed JSON', async () => {
    await expect(parseRequestBody({
      text: () => Promise.resolve('{bad json'),
    } as never)).rejects.toBeInstanceOf(ValidationError)
  })

  test('throws when the request body is empty', async () => {
    await expect(parseRequestBody({
      text: () => Promise.resolve('   '),
    } as never)).rejects.toThrow('Request body is empty or missing')
  })
})

describe('errorResponse', () => {
  test('redacts server errors and logs them', async () => {
    const req = {
      payload: {
        logger: {
          error: vi.fn(),
        },
      },
    }

    const response = errorResponse(req as never, Object.assign(new Error('boom'), {
      statusCode: 500,
    }))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' })
    expect(req.payload.logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      '[GMC Plugin] boom',
    )
  })

  test('returns validation messages for client errors', async () => {
    const response = errorResponse({ payload: {} } as never, Object.assign(new Error('bad input'), {
      statusCode: 400,
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'bad input' })
  })

  test.each([200, 399, 600, Number.NaN, 418.5, '400'])(
    'fails closed for an untrusted statusCode value %p',
    async (statusCode) => {
      const logger = { error: vi.fn() }
      const error = Object.assign(new Error('must stay private'), { statusCode })

      const response = errorResponse({ payload: { logger } } as never, error)

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({ error: 'Internal server error' })
      expect(logger.error).toHaveBeenCalled()
    },
  )
})
