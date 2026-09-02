import type { MCProductIdentity } from '../types/index.js'
import type { GmcApiPrimaryDataSource } from './types.js'

import { canonicalJson } from './canonical.js'

const MAX_DATA_SOURCE_RESPONSE_BYTES = 1024 * 1024

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export class GmcApiPrimaryDataSourceRequiredError extends TypeError {
  readonly code = 'GMC_API_PRIMARY_DATA_SOURCE_REQUIRED'

  constructor(message: string) {
    super(message)
    this.name = 'GmcApiPrimaryDataSourceRequiredError'
  }
}

/**
 * ProductInput.insert moves an existing processed identity when it names a
 * different data source. V2 never performs that destructive ownership
 * transfer implicitly.
 */
export class GmcProductDataSourceConflictError extends TypeError {
  readonly code = 'GMC_PRODUCT_DATA_SOURCE_CONFLICT'

  constructor(args: { actualDataSourceName: string; expectedDataSourceName: string }) {
    super(
      `Processed Merchant product is owned by ${args.actualDataSourceName}; refusing to move it to ${args.expectedDataSourceName}`,
    )
    this.name = 'GmcProductDataSourceConflictError'
  }
}

/**
 * ProductInput processing is asynchronous. Local inventory is attached to the
 * processed product, so an accepted ProductInput may legitimately be absent
 * for a short interval and must converge through durable retry rather than be
 * discarded as a terminal validation failure.
 */
export class GmcProcessedProductNotReadyError extends Error {
  readonly code = 'GMC_PROCESSED_PRODUCT_NOT_READY'

  constructor(identity: MCProductIdentity) {
    super(
      `Processed Merchant product ${identity.contentLanguage}/${identity.feedLabel}/${identity.offerId} is not visible for local inventory yet`,
    )
    this.name = 'GmcProcessedProductNotReadyError'
  }
}

export const assertGmcApiPrimaryDataSource = (
  value: unknown,
  expectedName: string,
): GmcApiPrimaryDataSource => {
  if (
    !plainObject(value) ||
    value.name !== expectedName ||
    value.input !== 'API' ||
    (value.contentLanguage === undefined) !== (value.feedLabel === undefined) ||
    (value.contentLanguage !== undefined &&
      (typeof value.contentLanguage !== 'string' || !/^[a-z]{2}$/.test(value.contentLanguage))) ||
    (value.feedLabel !== undefined &&
      (typeof value.feedLabel !== 'string' || !/^[A-Z0-9_-]{1,20}$/.test(value.feedLabel)))
  ) {
    throw new GmcApiPrimaryDataSourceRequiredError(
      `Merchant data source ${expectedName} must resolve to a validated API-backed primary product data source`,
    )
  }
  return value as GmcApiPrimaryDataSource
}

/**
 * Validate the Google control-plane resource before any product-plane call.
 * ProductInput versioning, ownership, and deletion semantics in v2 require a
 * primary API source; a FILE or supplemental source is not interchangeable.
 */
export const parseGmcApiPrimaryDataSource = (
  value: unknown,
  expectedName: string,
): GmcApiPrimaryDataSource => {
  if (!plainObject(value)) {
    throw new GmcApiPrimaryDataSourceRequiredError(
      'Merchant data source response must be an object',
    )
  }
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_DATA_SOURCE_RESPONSE_BYTES) {
    throw new GmcApiPrimaryDataSourceRequiredError(
      'Merchant data source response exceeds its safety limit',
    )
  }
  const expectedId = expectedName.split('/').at(-1)
  if (
    value.name !== expectedName ||
    value.dataSourceId !== expectedId ||
    value.input !== 'API' ||
    !plainObject(value.primaryProductDataSource)
  ) {
    throw new GmcApiPrimaryDataSourceRequiredError(
      `Merchant data source ${expectedName} must be an API-backed primary product data source`,
    )
  }

  const primary = value.primaryProductDataSource
  const contentLanguage = primary.contentLanguage
  const feedLabel = primary.feedLabel
  if ((contentLanguage === undefined) !== (feedLabel === undefined)) {
    throw new GmcApiPrimaryDataSourceRequiredError(
      `Merchant data source ${expectedName} must set contentLanguage and feedLabel together or leave both unset`,
    )
  }
  if (
    contentLanguage !== undefined &&
    (typeof contentLanguage !== 'string' || !/^[a-z]{2}$/.test(contentLanguage))
  ) {
    throw new GmcApiPrimaryDataSourceRequiredError(
      `Merchant data source ${expectedName} has an invalid contentLanguage`,
    )
  }
  if (
    feedLabel !== undefined &&
    (typeof feedLabel !== 'string' || !/^[A-Z0-9_-]{1,20}$/.test(feedLabel))
  ) {
    throw new GmcApiPrimaryDataSourceRequiredError(
      `Merchant data source ${expectedName} has an invalid feedLabel`,
    )
  }

  return assertGmcApiPrimaryDataSource(
    {
      ...(contentLanguage === undefined ? {} : { contentLanguage }),
      ...(feedLabel === undefined ? {} : { feedLabel }),
      name: expectedName,
      input: 'API',
    },
    expectedName,
  )
}

/**
 * Multiple API-primary sources are safe only when their immutable targeting
 * scopes are complete and pairwise disjoint. An unrestricted source overlaps
 * every other source and would allow two routes to address the same processed
 * product identity.
 */
export const assertGmcApiPrimaryDataSourceTopology = (
  dataSources: readonly GmcApiPrimaryDataSource[],
): void => {
  if (dataSources.length <= 1) {
    return
  }
  const scopes = new Map<string, string>()
  for (const dataSource of dataSources) {
    if (dataSource.contentLanguage === undefined || dataSource.feedLabel === undefined) {
      throw new GmcApiPrimaryDataSourceRequiredError(
        `Merchant data source ${dataSource.name} must have an immutable contentLanguage/feedLabel scope when multiple API-primary sources are configured`,
      )
    }
    const scope = `${dataSource.contentLanguage}\u0000${dataSource.feedLabel}`
    const existing = scopes.get(scope)
    if (existing) {
      throw new GmcApiPrimaryDataSourceRequiredError(
        `Merchant data sources ${existing} and ${dataSource.name} overlap on ${dataSource.contentLanguage}/${dataSource.feedLabel}`,
      )
    }
    scopes.set(scope, dataSource.name)
  }
}

export const assertGmcApiDataSourceAcceptsIdentity = (
  dataSource: GmcApiPrimaryDataSource,
  identity: MCProductIdentity,
): void => {
  if (
    (dataSource.contentLanguage !== undefined &&
      dataSource.contentLanguage !== identity.contentLanguage) ||
    (dataSource.feedLabel !== undefined && dataSource.feedLabel !== identity.feedLabel)
  ) {
    throw new GmcApiPrimaryDataSourceRequiredError(
      `Merchant data source ${dataSource.name} does not accept ${identity.contentLanguage}/${identity.feedLabel}`,
    )
  }
}
