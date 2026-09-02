import type { GmcApiCustomAttribute } from './types.js'

export type GmcCustomAttributeIssue = {
  code: string
  message: string
  path: string
}

const MAX_NODES = 2_500
const MAX_CHARACTERS = 102_400
const MAX_CHARACTERS_PER_NODE = 10_240
// Google does not publish a nesting ceiling. This plugin boundary prevents a
// hostile or accidentally recursive projection from consuming the call stack.
const MAX_DEPTH = 20

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })

const normalizedName = (value: string): string =>
  value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US')

export const normalizeGmcCustomAttributes = (
  value: unknown,
  path: string,
): { attributes?: GmcApiCustomAttribute[]; issues: GmcCustomAttributeIssue[] } => {
  const issues: GmcCustomAttributeIssue[] = []
  if (value === undefined) {
    return { issues }
  }
  if (!Array.isArray(value)) {
    return {
      issues: [{ code: 'type', message: 'must be an array', path }],
    }
  }

  let nodeCount = 0
  let totalCharacters = 0

  const visitAttribute = (
    attribute: unknown,
    attributePath: string,
    depth: number,
  ): GmcApiCustomAttribute => {
    nodeCount += 1
    if (depth > MAX_DEPTH) {
      issues.push({
        code: 'depth',
        message: `must not exceed ${MAX_DEPTH} nested custom-attribute levels`,
        path: attributePath,
      })
      return { name: '' }
    }
    if (!isRecord(attribute)) {
      issues.push({ code: 'type', message: 'must be an object', path: attributePath })
      return { name: '' }
    }

    const unsupported = Object.keys(attribute).filter(
      (field) => !['groupValues', 'id', 'name', 'value'].includes(field),
    )
    if (unsupported.length > 0) {
      issues.push({
        code: 'field',
        message: `contains unsupported field${unsupported.length === 1 ? '' : 's'}: ${unsupported.sort().join(', ')}`,
        path: attributePath,
      })
    }

    const name = attribute.name
    const validName = typeof name === 'string' && name.trim().length > 0
    if (!validName) {
      issues.push({
        code: 'required',
        message: 'must be a non-empty string',
        path: `${attributePath}.name`,
      })
    } else if (hasControlCharacters(name)) {
      issues.push({
        code: 'characters',
        message: 'must not contain control characters',
        path: `${attributePath}.name`,
      })
    }

    if (attribute.value !== undefined && typeof attribute.value !== 'string') {
      issues.push({
        code: 'type',
        message: 'must be a string when supplied',
        path: `${attributePath}.value`,
      })
    }
    if (attribute.groupValues !== undefined && !Array.isArray(attribute.groupValues)) {
      issues.push({
        code: 'type',
        message: 'must be an array when supplied',
        path: `${attributePath}.groupValues`,
      })
    }

    const hasValue = typeof attribute.value === 'string' && attribute.value.trim().length > 0
    const hasGroup = Array.isArray(attribute.groupValues) && attribute.groupValues.length > 0
    if (hasValue === hasGroup) {
      issues.push({
        code: 'exclusive',
        message: 'requires exactly one non-empty value or non-empty groupValues array',
        path: attributePath,
      })
    }

    const ownCharacters =
      (typeof name === 'string' ? [...name].length : 0) +
      (typeof attribute.value === 'string' ? [...attribute.value].length : 0)
    totalCharacters += ownCharacters
    if (ownCharacters > MAX_CHARACTERS_PER_NODE) {
      issues.push({
        code: 'length',
        message: `name and value must not exceed ${MAX_CHARACTERS_PER_NODE} characters combined`,
        path: attributePath,
      })
    }

    const result: GmcApiCustomAttribute = { name: typeof name === 'string' ? name : '' }
    if (hasValue && typeof attribute.value === 'string') {
      result.value = attribute.value
    }
    if (hasGroup && Array.isArray(attribute.groupValues)) {
      result.groupValues = visitList(
        attribute.groupValues,
        `${attributePath}.groupValues`,
        depth + 1,
      )
    }
    return result
  }

  const visitList = (
    attributes: unknown[],
    listPath: string,
    depth: number,
  ): GmcApiCustomAttribute[] => {
    const names = new Set<string>()
    return attributes.map((attribute, index) => {
      const attributePath = `${listPath}[${index}]`
      if (isRecord(attribute) && typeof attribute.name === 'string') {
        const name = normalizedName(attribute.name)
        if (name && names.has(name)) {
          issues.push({
            code: 'duplicate',
            message: 'sibling custom attribute names must be unique after Google normalization',
            path: `${attributePath}.name`,
          })
        }
        if (name) {
          names.add(name)
        }
      }
      return visitAttribute(attribute, attributePath, depth)
    })
  }

  const attributes = visitList(value, path, 1)
  if (nodeCount > MAX_NODES) {
    issues.push({
      code: 'count',
      message: `must not contain more than ${MAX_NODES} custom attributes across all levels`,
      path,
    })
  }
  if (totalCharacters > MAX_CHARACTERS) {
    issues.push({
      code: 'length',
      message: `must not exceed ${MAX_CHARACTERS} total characters`,
      path,
    })
  }

  return { attributes, issues }
}
