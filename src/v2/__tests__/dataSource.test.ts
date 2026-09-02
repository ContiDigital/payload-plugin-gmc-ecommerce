import { describe, expect, it } from 'vitest'

import {
  assertGmcApiDataSourceAcceptsIdentity,
  assertGmcApiPrimaryDataSourceTopology,
  parseGmcApiPrimaryDataSource,
} from '../dataSource.js'

const name = 'accounts/123456/dataSources/987654321'

describe('Merchant API-primary data-source boundary', () => {
  it('accepts unrestricted and identity-scoped primary API sources', () => {
    expect(
      parseGmcApiPrimaryDataSource(
        {
          name,
          dataSourceId: '987654321',
          input: 'API',
          primaryProductDataSource: {},
        },
        name,
      ),
    ).toEqual({ name, input: 'API' })

    const scoped = parseGmcApiPrimaryDataSource(
      {
        name,
        dataSourceId: '987654321',
        input: 'API',
        primaryProductDataSource: { contentLanguage: 'en', feedLabel: 'US' },
      },
      name,
    )
    expect(() =>
      assertGmcApiDataSourceAcceptsIdentity(scoped, {
        contentLanguage: 'en',
        feedLabel: 'US',
        offerId: 'sku-1',
      }),
    ).not.toThrow()
    expect(() =>
      assertGmcApiDataSourceAcceptsIdentity(scoped, {
        contentLanguage: 'fr',
        feedLabel: 'US',
        offerId: 'sku-1',
      }),
    ).toThrow(/does not accept fr\/US/i)
  })

  it.each([
    {
      name,
      dataSourceId: '987654321',
      input: 'FILE',
      primaryProductDataSource: {},
    },
    {
      name,
      dataSourceId: '987654321',
      input: 'API',
      supplementalProductDataSource: {},
    },
    {
      name,
      dataSourceId: '111111111',
      input: 'API',
      primaryProductDataSource: {},
    },
    {
      name: 'accounts/999999/dataSources/987654321',
      dataSourceId: '987654321',
      input: 'API',
      primaryProductDataSource: {},
    },
  ])('rejects file, supplemental, or mismatched sources', (value) => {
    expect(() => parseGmcApiPrimaryDataSource(value, name)).toThrowError(
      expect.objectContaining({ code: 'GMC_API_PRIMARY_DATA_SOURCE_REQUIRED' }),
    )
  })

  it('bounds and validates targeting metadata', () => {
    expect(() =>
      parseGmcApiPrimaryDataSource(
        {
          name,
          dataSourceId: '987654321',
          input: 'API',
          primaryProductDataSource: { contentLanguage: 'EN', feedLabel: 'US' },
        },
        name,
      ),
    ).toThrow(/invalid contentLanguage/i)

    expect(() =>
      parseGmcApiPrimaryDataSource(
        {
          name,
          dataSourceId: '987654321',
          input: 'API',
          primaryProductDataSource: {},
          unexpected: 'x'.repeat(1024 * 1024),
        },
        name,
      ),
    ).toThrow(/safety limit/i)
  })

  it('requires paired scopes and pairwise-disjoint routing for multiple primary sources', () => {
    expect(() =>
      parseGmcApiPrimaryDataSource(
        {
          name,
          dataSourceId: '987654321',
          input: 'API',
          primaryProductDataSource: { contentLanguage: 'en' },
        },
        name,
      ),
    ).toThrow(/set contentLanguage and feedLabel together/i)

    expect(() =>
      assertGmcApiPrimaryDataSourceTopology([
        { name, input: 'API' },
        {
          name: 'accounts/123456/dataSources/222222222',
          contentLanguage: 'fr',
          feedLabel: 'FR',
          input: 'API',
        },
      ]),
    ).toThrow(/must have an immutable contentLanguage\/feedLabel scope/i)

    expect(() =>
      assertGmcApiPrimaryDataSourceTopology([
        { name, contentLanguage: 'en', feedLabel: 'US', input: 'API' },
        {
          name: 'accounts/123456/dataSources/222222222',
          contentLanguage: 'en',
          feedLabel: 'US',
          input: 'API',
        },
      ]),
    ).toThrow(/overlap on en\/US/i)

    expect(() =>
      assertGmcApiPrimaryDataSourceTopology([
        { name, contentLanguage: 'en', feedLabel: 'US', input: 'API' },
        {
          name: 'accounts/123456/dataSources/222222222',
          contentLanguage: 'fr',
          feedLabel: 'FR',
          input: 'API',
        },
      ]),
    ).not.toThrow()
  })
})
