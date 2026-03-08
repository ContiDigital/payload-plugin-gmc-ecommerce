import type { Payload } from 'payload'

import type { NormalizedPluginOptions, PayloadProductDoc } from '../../types/index.js'

export type ResolvedCategories = {
  /** The most specific google category ID found (last category with a valid ID) */
  googleProductCategory?: string
  /** Category names for MC productTypes field */
  productTypes?: string[]
}

/**
 * Resolve Google Product Category and product types from a product's category
 * relationships. Handles single and multi-category fields.
 *
 * When `parentField` is configured, walks up the parent chain to build the
 * full breadcrumb path for `productTypes`.
 *
 * For `googleProductCategory` (MC accepts ONE value): iterates all categories
 * and picks the **last** one that has a valid `googleCategoryIdField` — on the
 * assumption that categories are ordered general → specific.
 */
export const resolveGoogleCategory = async (
  product: PayloadProductDoc | Record<string, unknown>,
  options: NormalizedPluginOptions,
  payload: Payload,
): Promise<ResolvedCategories | undefined> => {
  const catConfig = options.collections.categories
  if (!catConfig) {
    return undefined
  }

  const { slug: catSlug, googleCategoryIdField, nameField, parentField, productCategoryField, productTypeField } = catConfig
  if (!productCategoryField) {
    return undefined
  }

  // productTypeField takes precedence; falls back to nameField
  const typeField = productTypeField || nameField

  const rawValue = product[productCategoryField]
  const categoryIds = extractAllRelationshipIds(rawValue)

  if (categoryIds.length === 0) {
    return undefined
  }

  let googleProductCategory: string | undefined
  const productTypes: string[] = []

  for (const categoryId of categoryIds) {
    try {
      const category = await payload.findByID({
        id: categoryId,
        collection: catSlug,
        depth: 0,
      }) as unknown as Record<string, unknown>

      // Build breadcrumb by walking up the parent chain
      if (parentField && typeField) {
        const breadcrumb = await buildBreadcrumb(category, catSlug, parentField, typeField, payload)
        if (breadcrumb.length > 0) {
          productTypes.push(...breadcrumb)
        }
      } else if (typeField) {
        // No parent traversal — just collect the direct category label
        const label = category[typeField]
        if (typeof label === 'string' && label.trim().length > 0) {
          productTypes.push(label.trim())
        }
      }

      // Pick up googleCategoryId — last valid one wins (most specific)
      if (googleCategoryIdField) {
        const googleCatId = category[googleCategoryIdField]
        if (googleCatId !== undefined && googleCatId !== null && googleCatId !== '') {
          googleProductCategory = typeof googleCatId === 'string'
            ? googleCatId
            : String(googleCatId as number)
        }
      }
    } catch {
      // Category not found or access denied — skip silently
    }
  }

  if (!googleProductCategory && productTypes.length === 0) {
    return undefined
  }

  return {
    ...(googleProductCategory ? { googleProductCategory } : {}),
    ...(productTypes.length > 0 ? { productTypes: [...new Set(productTypes)] } : {}),
  }
}

// ---------------------------------------------------------------------------
// Parent chain traversal — build breadcrumb path from leaf to root
// ---------------------------------------------------------------------------

const MAX_PARENT_DEPTH = 10

const buildBreadcrumb = async (
  startCategory: Record<string, unknown>,
  catSlug: string,
  parentField: string,
  typeField: string,
  payload: Payload,
): Promise<string[]> => {
  const initialLabel = startCategory[typeField]
  if (typeof initialLabel === 'string' && initialLabel.includes(' > ')) {
    return [initialLabel.trim()]
  }

  const segments: string[] = []
  let current: Record<string, unknown> | undefined = startCategory
  const visited = new Set<string>()

  for (let depth = 0; depth < MAX_PARENT_DEPTH && current; depth++) {
    const label = current[typeField]
    if (typeof label === 'string' && label.trim().length > 0) {
      segments.unshift(label.trim())
    }

    // Follow parent relationship
    const parentRef = current[parentField]
    const parentId = extractSingleId(parentRef)

    if (!parentId || visited.has(parentId)) {
      break
    }

    visited.add(parentId)

    try {
      current = await payload.findByID({
        id: parentId,
        collection: catSlug,
        depth: 0,
      }) as unknown as Record<string, unknown>
    } catch {
      break
    }
  }

  // Return full breadcrumb path as a single productType entry (e.g. "Furniture > Chairs > Dining Chairs")
  // MC productTypes accepts multiple entries; each can be a breadcrumb path
  if (segments.length > 0) {
    return [segments.join(' > ')]
  }

  return []
}

// ---------------------------------------------------------------------------
// Relationship ID extraction — handles all Payload relationship formats
// ---------------------------------------------------------------------------

const extractAllRelationshipIds = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    const ids: string[] = []
    for (const item of value) {
      const id = extractSingleId(item)
      if (id) {
        ids.push(id)
      }
    }
    return ids
  }

  const single = extractSingleId(value)
  return single ? [single] : []
}

const extractSingleId = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>
    // Populated relationship object
    if (obj.id !== undefined && obj.id !== null) {
      return typeof obj.id === 'string' ? obj.id : String(obj.id as number)
    }
    // Payload polymorphic relationship: { relationTo, value }
    if (obj.value !== undefined && obj.value !== null) {
      return extractSingleId(obj.value)
    }
  }
  return undefined
}
