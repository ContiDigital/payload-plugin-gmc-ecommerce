import type { Payload } from 'payload'

import type {
  FieldMapping,
  MCProductAttributes,
  MCProductInput,
  MCProductState,
  NormalizedPluginOptions,
  PayloadProductDoc,
  ResolvedMCIdentity,
} from '../../types/index.js'

import {
  GMC_FIELD_MAPPINGS_SLUG,
  MC_FIELD_GROUP_NAME,
  MC_PRODUCT_ATTRIBUTES_FIELD_NAME,
} from '../../constants.js'
import { asRecord } from '../utilities/recordUtils.js'
import { resolveGoogleCategory } from './categoryResolver.js'
import { applyFieldMappings, deepMerge } from './fieldMapping.js'
import { buildProductInput } from './transformers.js'

const isFieldMappingRecord = (value: unknown): value is FieldMapping => {
  const record = asRecord(value)
  return (
    typeof record.source === 'string' &&
    typeof record.syncMode === 'string' &&
    typeof record.target === 'string'
  )
}

const cloneProduct = (product: PayloadProductDoc): PayloadProductDoc => {
  const currentMC: MCProductState = product[MC_FIELD_GROUP_NAME] ?? {}
  const currentAttrs: MCProductAttributes = currentMC[MC_PRODUCT_ATTRIBUTES_FIELD_NAME] ?? {}

  return {
    ...product,
    [MC_FIELD_GROUP_NAME]: {
      ...currentMC,
      [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: { ...currentAttrs },
    },
  } as PayloadProductDoc
}

export const loadMergedFieldMappings = async (
  payload: Payload,
  options: NormalizedPluginOptions,
): Promise<FieldMapping[]> => {
  const allMappings = [...options.collections.products.fieldMappings]

  try {
    const runtimeMappings = await payload.find({
      collection: GMC_FIELD_MAPPINGS_SLUG as never,
      depth: 0,
      limit: 100,
      overrideAccess: true,
      sort: 'order',
    })

    for (const doc of runtimeMappings.docs) {
      const mapping = asRecord(doc)
      if (!isFieldMappingRecord(mapping)) {
        continue
      }

      if (mapping.source && mapping.target && mapping.syncMode) {
        allMappings.push({
          order: mapping.order,
          source: mapping.source,
          syncMode: mapping.syncMode,
          target: mapping.target,
          transformPreset: mapping.transformPreset,
        })
      }
    }
  } catch {
    // Runtime mappings are additive. If the utility collection is unavailable,
    // continue with config-time mappings so push operations remain functional.
  }

  return allMappings
}

export const prepareProductForSync = async (args: {
  identity: ResolvedMCIdentity
  options: NormalizedPluginOptions
  payload: Payload
  product: PayloadProductDoc | Record<string, unknown>
}): Promise<{
  action: 'insert' | 'update'
  input: MCProductInput
  product: PayloadProductDoc
}> => {
  const { identity, options, payload, product } = args
  const preparedProduct = cloneProduct(product as PayloadProductDoc)
  const allMappings = await loadMergedFieldMappings(payload, options)

  if (allMappings.length > 0) {
    const mappedValues = applyFieldMappings(
      preparedProduct as Record<string, unknown>,
      allMappings,
      undefined,
      { siteUrl: options.siteUrl },
    )
    const currentMC: MCProductState = preparedProduct[MC_FIELD_GROUP_NAME] ?? {}
    const currentAttrs: MCProductAttributes = currentMC[MC_PRODUCT_ATTRIBUTES_FIELD_NAME] ?? {}
    const mappedAttrs = (mappedValues.productAttributes ?? mappedValues) as Record<string, unknown>

    preparedProduct[MC_FIELD_GROUP_NAME] = {
      ...currentMC,
      [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: deepMerge(
        currentAttrs as Record<string, unknown>,
        mappedAttrs,
      ) as MCProductAttributes,
    }
  }

  const resolvedCategories = await resolveGoogleCategory(
    preparedProduct as Record<string, unknown>,
    options,
    payload,
  )
  if (resolvedCategories) {
    const currentMC: MCProductState = preparedProduct[MC_FIELD_GROUP_NAME] ?? {}
    const currentAttrs: MCProductAttributes = currentMC[MC_PRODUCT_ATTRIBUTES_FIELD_NAME] ?? {}

    preparedProduct[MC_FIELD_GROUP_NAME] = {
      ...currentMC,
      [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: {
        ...currentAttrs,
        ...(currentAttrs.googleProductCategory
          ? {}
          : resolvedCategories.googleProductCategory
            ? { googleProductCategory: resolvedCategories.googleProductCategory }
            : {}),
        ...(currentAttrs.productTypes
          ? {}
          : resolvedCategories.productTypes
            ? { productTypes: resolvedCategories.productTypes }
            : {}),
      },
    }
  }

  const mcState: MCProductState | undefined = preparedProduct[MC_FIELD_GROUP_NAME]
  const hasSnapshot =
    mcState?.snapshot &&
    typeof mcState.snapshot === 'object' &&
    Object.keys(mcState.snapshot).length > 0
  const action: 'insert' | 'update' = hasSnapshot ? 'update' : 'insert'

  let input = buildProductInput(preparedProduct, identity, options)

  if (options.beforePush) {
    input = await options.beforePush({
      doc: preparedProduct,
      operation: action,
      payload,
      productInput: input,
    })
  }

  return { action, input, product: preparedProduct }
}

const REQUIRED_PRODUCT_FIELDS = ['title', 'link', 'imageLink', 'availability'] as const

export const validateRequiredProductInput = (input: MCProductInput): string[] => {
  const attrs = input.productAttributes
  if (!attrs) {
    return [...REQUIRED_PRODUCT_FIELDS]
  }

  return REQUIRED_PRODUCT_FIELDS.filter((field) => {
    const value = attrs[field]
    return (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim().length === 0)
    )
  })
}
