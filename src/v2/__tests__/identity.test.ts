import { describe, expect, it } from 'vitest'

import { getMerchantProductId, getProcessedProductName, getProductInputName } from '../identity.js'

describe('Merchant product resource names', () => {
  it('always uses the Merchant API recommended unpadded base64url form', () => {
    const identity = { contentLanguage: 'en', feedLabel: 'US', offerId: 'sku/100%~blue' }
    const encoded = Buffer.from(getMerchantProductId(identity), 'utf8').toString('base64url')

    expect(getProductInputName(identity, '123')).toBe(`accounts/123/productInputs/${encoded}`)
    expect(getProcessedProductName(identity, '123')).toBe(`accounts/123/products/${encoded}`)
    expect(encoded).not.toMatch(/[=/%~]/)
  })
})
