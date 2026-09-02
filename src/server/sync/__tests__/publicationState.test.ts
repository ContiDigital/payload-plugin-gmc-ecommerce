import { describe, expect, test } from 'vitest'

import { isLiveDocument } from '../publicationState.js'

const draftsOn = { versions: { drafts: true } } as never
const draftsOff = { versions: { drafts: false } } as never

describe('isLiveDocument', () => {
  test('every document is live on a collection that does not store drafts', () => {
    expect(isLiveDocument({ collection: draftsOff, doc: {} })).toBe(true)
    expect(isLiveDocument({ collection: draftsOff, doc: { _status: 'draft' } })).toBe(true)
    expect(isLiveDocument({ collection: undefined, doc: {} })).toBe(true)
  })

  test('a published document is live when drafts are enabled', () => {
    expect(isLiveDocument({ collection: draftsOn, doc: { _status: 'published' } })).toBe(true)
  })

  test('a draft is not live', () => {
    expect(isLiveDocument({ collection: draftsOn, doc: { _status: 'draft' } })).toBe(false)
  })

  test('an unreadable status on a drafts collection is not treated as live', () => {
    expect(isLiveDocument({ collection: draftsOn, doc: {} })).toBe(false)
    expect(isLiveDocument({ collection: draftsOn, doc: { _status: 42 } })).toBe(false)
  })

  test('a localized status counts as live only when every locale is published', () => {
    const allPublished = { _status: { en: 'published', es: 'published' } }
    const oneDraft = { _status: { en: 'published', es: 'draft' } }

    expect(isLiveDocument({ collection: draftsOn, doc: allPublished })).toBe(true)
    expect(isLiveDocument({ collection: draftsOn, doc: oneDraft })).toBe(false)
    expect(isLiveDocument({ collection: draftsOn, doc: { _status: {} } })).toBe(false)
  })

  test('drafts configured as an object still counts as a drafts collection', () => {
    const autosave = { versions: { drafts: { autosave: true } } } as never

    expect(isLiveDocument({ collection: autosave, doc: { _status: 'draft' } })).toBe(false)
    expect(isLiveDocument({ collection: autosave, doc: { _status: 'published' } })).toBe(true)
  })
})
