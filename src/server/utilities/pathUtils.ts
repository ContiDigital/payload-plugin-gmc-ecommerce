/**
 * Access a nested property by dot-separated path with optional array index syntax.
 * e.g. "images[0].url", "price.amount"
 */
export const getByPath = (obj: Record<string, unknown>, path: string): unknown => {
  const segments = path.split('.')
  let current: unknown = obj
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    const arrayMatch = segment.match(/^(\w+)\[(\d+)\]$/)
    if (arrayMatch) {
      const arr = (current as Record<string, unknown>)[arrayMatch[1]]
      if (Array.isArray(arr)) {
        current = arr[Number(arrayMatch[2])]
      } else {
        return undefined
      }
    } else {
      current = (current as Record<string, unknown>)[segment]
    }
  }
  return current
}

/**
 * Set a nested property by dot-separated path, creating intermediate objects as needed.
 */
export const setByPath = (obj: Record<string, unknown>, path: string, value: unknown): void => {
  const segments = path.split('.')
  let current = obj
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]
    if (!(segment in current) || typeof current[segment] !== 'object' || current[segment] === null) {
      current[segment] = {}
    }
    current = current[segment] as Record<string, unknown>
  }
  current[segments[segments.length - 1]] = value
}
