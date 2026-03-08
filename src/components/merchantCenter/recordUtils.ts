export const asClientRecord = (
  value: unknown,
): Record<string, unknown> | undefined => {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

export const getClientString = (
  value: unknown,
  fallback: string,
): string => {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}
