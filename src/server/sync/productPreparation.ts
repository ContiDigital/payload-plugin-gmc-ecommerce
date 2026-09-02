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
import { buildProductInput, reverseTransformProduct } from './transformers.js'

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
  /**
   * Attributes preparation computed that the stored document does not already
   * own, in Payload storage shape, keyed as they sit under `mc.attrs`.
   *
   * The push persists exactly these and nothing else. Values the document
   * already owns — anything an editor typed, and anything a `permanent`
   * mapping recomputes on every save — are deliberately absent: writing them
   * back from a document read before the Merchant Center round-trip would
   * revert whatever was saved in the meantime.
   */
  derivedAttributes: Record<string, unknown>
  input: MCProductInput
  product: PayloadProductDoc
}> => {
  const { identity, options, payload, product } = args
  const preparedProduct = cloneProduct(product as PayloadProductDoc)
  const existingMCState: MCProductState | undefined = preparedProduct[MC_FIELD_GROUP_NAME]
  const hasSnapshot =
    existingMCState?.snapshot &&
    typeof existingMCState.snapshot === 'object' &&
    Object.keys(existingMCState.snapshot).length > 0
  const action: 'insert' | 'update' = hasSnapshot ? 'update' : 'insert'
  const allMappings = await loadMergedFieldMappings(payload, options)
  const activeMappings = allMappings.filter((mapping) =>
    mapping.syncMode === 'permanent' || (mapping.syncMode === 'initialOnly' && action === 'insert'),
  )

  if (activeMappings.length > 0) {
    const mappedValues = applyFieldMappings(
      preparedProduct as Record<string, unknown>,
      activeMappings,
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

  // `initialOnly` mappings seed an attribute once, on the first insert, and the
  // editor owns it from then on. That seeding only survives if the push writes
  // it back, so it is recorded as derived. It is computed as its own pass so
  // the combined pass above keeps deciding the wire input exactly as before.
  const wireDerivedAttributes: Record<string, unknown> = {}

  if (action === 'insert') {
    const seeded = applyFieldMappings(
      preparedProduct as Record<string, unknown>,
      allMappings,
      'initialOnly',
      { siteUrl: options.siteUrl },
    )

    Object.assign(
      wireDerivedAttributes,
      (seeded.productAttributes ?? seeded) as Record<string, unknown>,
    )
  }

  const resolvedCategories = await resolveGoogleCategory(
    preparedProduct as Record<string, unknown>,
    options,
    payload,
  )
  if (resolvedCategories) {
    const currentMC: MCProductState = preparedProduct[MC_FIELD_GROUP_NAME] ?? {}
    const currentAttrs: MCProductAttributes = currentMC[MC_PRODUCT_ATTRIBUTES_FIELD_NAME] ?? {}

    // Resolution only ever fills a gap — an attribute the document sets itself
    // always wins — so whatever it contributes here is by definition derived.
    const resolvedFill = {
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
    }

    Object.assign(wireDerivedAttributes, resolvedFill)

    preparedProduct[MC_FIELD_GROUP_NAME] = {
      ...currentMC,
      [MC_PRODUCT_ATTRIBUTES_FIELD_NAME]: {
        ...currentAttrs,
        ...resolvedFill,
      },
    }
  }

  let input = buildProductInput(preparedProduct, identity, options)

  if (options.beforePush) {
    input = await options.beforePush({
      doc: preparedProduct,
      operation: action,
      payload,
      productInput: input,
    })
  }

  // Everything above is in Merchant Center wire shape — `productTypes` is a
  // `string[]` (categoryResolver.ts:9), `additionalImageLinks` likewise. The
  // document stores those as Payload array rows (`[{ value }]`, `[{ url }]`),
  // so the derived set is converted before any caller can persist it. Writing
  // wire shape into an array field would leave the adapter with rows it cannot
  // give a primary key to, after it has already emptied the array's table.
  const derivedAttributes = (reverseTransformProduct({
    productAttributes: wireDerivedAttributes,
  }).productAttributes ?? {})

  return { action, derivedAttributes, input, product: preparedProduct }
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
