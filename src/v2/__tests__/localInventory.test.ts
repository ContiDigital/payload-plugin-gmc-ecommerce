import { describe, expect, it } from 'vitest'

import {
  assertLocalInventoryMatchesProductPrice,
  canonicalizeLocalInventoryInput,
} from '../localInventory.js'

describe('canonicalizeLocalInventoryInput', () => {
  const available = { availability: 'IN_STOCK' as const }

  it('accepts and preserves the current Merchant Inventories v1 resource shape', () => {
    expect(
      canonicalizeLocalInventoryInput({
        localInventoryAttributes: {
          availability: 'IN_STOCK',
          localShippingLabel: 'same-day',
          loyaltyPrograms: [
            {
              cashbackForFutureUse: { amountMicros: '500000', currencyCode: 'USD' },
              loyaltyPoints: '20',
              memberPriceEffectiveInterval: {
                endTime: '2026-09-01T16:00:00.123456789Z',
                startTime: '2026-08-30T12:00:00.123456789-04:00',
              },
              price: { amountMicros: '10990000', currencyCode: 'USD' },
              programLabel: 'gallery_club',
              shippingLabel: 'member-delivery',
              tierLabel: 'gold',
            },
          ],
          pickupMethod: 'BUY',
          pickupSla: 'SAME_DAY',
          price: { amountMicros: '12990000', currencyCode: 'USD' },
          quantity: '3',
          salePrice: { amountMicros: '11990000', currencyCode: 'USD' },
          salePriceEffectiveDate: {
            endTime: '2026-09-01T16:00:00Z',
            startTime: '2026-08-30T12:00:00-04:00',
          },
        },
        storeCode: ' store-1 ',
      }),
    ).toMatchObject({
      localInventoryAttributes: {
        availability: 'IN_STOCK',
        localShippingLabel: 'same-day',
        loyaltyPrograms: [
          expect.objectContaining({
            loyaltyPoints: '20',
            programLabel: 'gallery_club',
            tierLabel: 'gold',
          }),
        ],
        quantity: '3',
      },
      storeCode: 'store-1',
    })
  })

  it('preserves recursive API custom attributes and removes Payload row IDs', () => {
    expect(
      canonicalizeLocalInventoryInput({
        localInventoryAttributes: {
          ...available,
          customAttributes: [
            {
              name: 'location',
              groupValues: [{ id: 'child-row', name: 'aisle', value: '4' } as never],
            },
          ],
        },
        storeCode: 'store-1',
      }).localInventoryAttributes.customAttributes,
    ).toEqual([{ name: 'location', groupValues: [{ name: 'aisle', value: '4' }] }])
  })

  it('enforces pickup pair, integer quantity, price, and byte limits', () => {
    expect(() =>
      canonicalizeLocalInventoryInput({
        localInventoryAttributes: { ...available, pickupMethod: 'BUY' },
        storeCode: 'store-1',
      }),
    ).toThrow(/pickupSla/)
    expect(() =>
      canonicalizeLocalInventoryInput({
        localInventoryAttributes: { ...available, quantity: '-1' },
        storeCode: 'store-1',
      }),
    ).toThrow(/quantity/)
    expect(() =>
      canonicalizeLocalInventoryInput({
        localInventoryAttributes: { ...available, instoreProductLocation: 'é'.repeat(11) },
        storeCode: 'store-1',
      }),
    ).toThrow(/20 bytes/)
  })

  it('rejects unsafe JSON, int64 overflow, intervals, and duplicate custom attributes', () => {
    const circular: Record<string, unknown> = { storeCode: 'store-1' }
    circular.localInventoryAttributes = circular
    expect(() => canonicalizeLocalInventoryInput(circular as never)).toThrow(/acyclic JSON/i)
    expect(() =>
      canonicalizeLocalInventoryInput({
        localInventoryAttributes: { ...available, quantity: '9223372036854775808' },
        storeCode: 'store-1',
      }),
    ).toThrow(/signed int64/i)
    expect(() =>
      canonicalizeLocalInventoryInput({
        localInventoryAttributes: {
          ...available,
          price: { amountMicros: '2000000', currencyCode: 'USD' },
          salePrice: { amountMicros: '1000000', currencyCode: 'USD' },
          salePriceEffectiveDate: { startTime: 'not-a-date' },
        },
        storeCode: 'store-1',
      }),
    ).toThrow(/startTime.*RFC 3339/i)
    expect(() =>
      canonicalizeLocalInventoryInput({
        localInventoryAttributes: {
          ...available,
          customAttributes: [
            { name: 'aisle', value: '1' },
            { name: 'aisle', value: '2' },
          ],
        },
        storeCode: 'store-1',
      }),
    ).toThrow(/attribute names must be unique/i)
  })

  it('rejects unknown root, attribute, price, interval, and loyalty fields', () => {
    const inputs = [
      {
        name: 'output-only',
        localInventoryAttributes: available,
        storeCode: 'store-1',
      },
      {
        localInventoryAttributes: { ...available, pickupCost: '3 USD' },
        storeCode: 'store-1',
      },
      {
        localInventoryAttributes: {
          ...available,
          price: { amountMicros: '1000000', currencyCode: 'USD', units: '1' },
        },
        storeCode: 'store-1',
      },
      {
        localInventoryAttributes: {
          ...available,
          price: { amountMicros: '1000000', currencyCode: 'USD' },
          salePrice: { amountMicros: '900000', currencyCode: 'USD' },
          salePriceEffectiveDate: { startTime: '2026-08-30T00:00:00Z', timezone: 'UTC' },
        },
        storeCode: 'store-1',
      },
      {
        localInventoryAttributes: {
          ...available,
          loyaltyPrograms: [{ points: '1', shippingLabel: 'member-delivery' }],
        },
        storeCode: 'store-1',
      },
    ]

    for (const input of inputs) {
      expect(() => canonicalizeLocalInventoryInput(input as never)).toThrow(/unsupported field/i)
    }
  })

  it('rejects malformed runtime Price values instead of trusting TypeScript', () => {
    const prices = [
      null,
      { amountMicros: 1000000, currencyCode: 'USD' },
      { amountMicros: '1000000', currencyCode: 'usd' },
      { amountMicros: '-1', currencyCode: 'USD' },
    ]

    for (const price of prices) {
      expect(() =>
        canonicalizeLocalInventoryInput({
          localInventoryAttributes: { ...available, price },
          storeCode: 'store-1',
        } as never),
      ).toThrow(/price/i)
    }
  })

  it('validates protobuf Timestamp syntax, calendar values, bounds, and instant order', () => {
    const timestamps = [
      '2026-02-29T00:00:00Z',
      '2026-08-30T00:00:00.1234567890Z',
      '2026-08-30T00:00:00+24:00',
      '0001-01-01T00:00:00+00:01',
      '9999-12-31T23:59:59-00:01',
    ]
    for (const startTime of timestamps) {
      expect(() =>
        canonicalizeLocalInventoryInput({
          localInventoryAttributes: {
            ...available,
            price: { amountMicros: '2000000', currencyCode: 'USD' },
            salePrice: { amountMicros: '1000000', currencyCode: 'USD' },
            salePriceEffectiveDate: { startTime },
          },
          storeCode: 'store-1',
        }),
      ).toThrow(/RFC 3339/i)
    }
    expect(() =>
      canonicalizeLocalInventoryInput({
        localInventoryAttributes: {
          ...available,
          price: { amountMicros: '2000000', currencyCode: 'USD' },
          salePrice: { amountMicros: '1000000', currencyCode: 'USD' },
          salePriceEffectiveDate: {
            endTime: '2026-08-30T00:00:00.000000001Z',
            startTime: '2026-08-30T00:00:00.000000002Z',
          },
        },
        storeCode: 'store-1',
      }),
    ).toThrow(/must not follow/i)
    expect(() =>
      canonicalizeLocalInventoryInput({
        localInventoryAttributes: {
          ...available,
          price: { amountMicros: '2000000', currencyCode: 'USD' },
          salePrice: { amountMicros: '1000000', currencyCode: 'USD' },
          salePriceEffectiveDate: {
            endTime: '2026-08-30T00:00:00.000000001Z',
            startTime: '2026-08-30T00:00:00.000000001Z',
          },
        },
        storeCode: 'store-1',
      }),
    ).not.toThrow()
  })

  it('enforces local price and currency consistency', () => {
    const invalidAttributes = [
      { ...available, salePrice: { amountMicros: '1', currencyCode: 'USD' } },
      {
        ...available,
        price: { amountMicros: '1', currencyCode: 'USD' },
        salePrice: { amountMicros: '2', currencyCode: 'USD' },
      },
      {
        ...available,
        price: { amountMicros: '2', currencyCode: 'USD' },
        salePrice: { amountMicros: '1', currencyCode: 'CAD' },
      },
      {
        ...available,
        loyaltyPrograms: [{ price: { amountMicros: '3', currencyCode: 'USD' } }],
        price: { amountMicros: '2', currencyCode: 'USD' },
      },
      {
        ...available,
        loyaltyPrograms: [{ cashbackForFutureUse: { amountMicros: '1', currencyCode: 'CAD' } }],
        price: { amountMicros: '2', currencyCode: 'USD' },
      },
    ]
    for (const localInventoryAttributes of invalidAttributes) {
      expect(() =>
        canonicalizeLocalInventoryInput({ localInventoryAttributes, storeCode: 'store-1' }),
      ).toThrow(/price|currency/i)
    }
  })

  it('cross-validates local and loyalty prices against the canonical online offer', () => {
    const productPrice = { amountMicros: '12000000', currencyCode: 'USD' }
    const valid = canonicalizeLocalInventoryInput({
      localInventoryAttributes: {
        ...available,
        loyaltyPrograms: [{ price: { amountMicros: '11000000', currencyCode: 'USD' } }],
      },
      storeCode: 'store-1',
    })
    expect(() => assertLocalInventoryMatchesProductPrice(valid, productPrice)).not.toThrow()

    const overpriced = canonicalizeLocalInventoryInput({
      localInventoryAttributes: {
        ...available,
        loyaltyPrograms: [{ price: { amountMicros: '13000000', currencyCode: 'USD' } }],
      },
      storeCode: 'store-1',
    })
    expect(() => assertLocalInventoryMatchesProductPrice(overpriced, productPrice)).toThrow(
      /must not exceed regular price/i,
    )

    const wrongCurrency = canonicalizeLocalInventoryInput({
      localInventoryAttributes: {
        ...available,
        price: { amountMicros: '12000000', currencyCode: 'CAD' },
      },
      storeCode: 'store-1',
    })
    expect(() => assertLocalInventoryMatchesProductPrice(wrongCurrency, productPrice)).toThrow(
      /canonical product price currency/i,
    )
  })

  it('rejects ineffective, ambiguous, and malformed loyalty benefits', () => {
    const loyaltyPrograms = [
      [{}],
      [{ loyaltyPoints: '9223372036854775808' }],
      [{ memberPriceEffectiveInterval: { startTime: '2026-08-30T00:00:00Z' } }],
      [
        { programLabel: 'CLUB', shippingLabel: 'one', tierLabel: 'Gold' },
        { programLabel: 'club', shippingLabel: 'two', tierLabel: 'gold' },
      ],
      [{ programLabel: ' club ', shippingLabel: 'member-delivery' }],
    ]
    for (const programs of loyaltyPrograms) {
      expect(() =>
        canonicalizeLocalInventoryInput({
          localInventoryAttributes: { ...available, loyaltyPrograms: programs },
          storeCode: 'store-1',
        } as never),
      ).toThrow(/loyalty|benefit|duplicate|canonical/i)
    }
  })

  it('enforces published string and serialized-input limits', () => {
    expect(() =>
      canonicalizeLocalInventoryInput({
        localInventoryAttributes: available,
        storeCode: 's'.repeat(65),
      }),
    ).toThrow(/1-64/)
    expect(() =>
      canonicalizeLocalInventoryInput({
        localInventoryAttributes: { ...available, localShippingLabel: 's'.repeat(101) },
        storeCode: 'store-1',
      }),
    ).toThrow(/100 characters/i)
    expect(() =>
      canonicalizeLocalInventoryInput({
        localInventoryAttributes: {
          ...available,
          instoreProductLocation: 'x'.repeat(263_000),
        },
        storeCode: 'store-1',
      }),
    ).toThrow(/262144 serialized bytes/)
  })
})
