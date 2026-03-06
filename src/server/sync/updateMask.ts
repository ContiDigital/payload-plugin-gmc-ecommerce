import type { MCCustomAttribute, MCProductAttributes } from '../../types/index.js'

const toSnakeCase = (str: string): string => {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase()
}

export const buildUpdateMask = (
  productAttributes?: MCProductAttributes,
  customAttributes?: MCCustomAttribute[],
): string => {
  const paths: string[] = []

  if (productAttributes) {
    for (const [key, value] of Object.entries(productAttributes)) {
      if (value === undefined) {
        continue
      }

      const snakeKey = toSnakeCase(key)

      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        // Nested objects like price, salePrice — include the parent path
        // The API expects e.g. "product_attributes.price" not "product_attributes.price.amount_micros"
        paths.push(`product_attributes.${snakeKey}`)
      } else {
        paths.push(`product_attributes.${snakeKey}`)
      }
    }
  }

  if (customAttributes && customAttributes.length > 0) {
    for (const attr of customAttributes) {
      if (attr.name && attr.name.trim().length > 0) {
        paths.push(`custom_attributes.${attr.name.trim()}`)
      }
    }
  }

  return paths.join(',')
}
