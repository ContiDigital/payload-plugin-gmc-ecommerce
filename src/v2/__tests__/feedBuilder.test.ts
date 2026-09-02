import { describe, expect, it, vi } from 'vitest'

import type { GmcArtifactFeedConfig } from '../types.js'

import { canonicalizeProductInput } from '../canonical.js'
import {
  assertFeedArtifactIntegrity,
  buildCanonicalFeed,
  publishFeedArtifact,
} from '../feed/buildFeed.js'

const product = (args: { feedLabel: string; offerId: string }) =>
  canonicalizeProductInput({
    input: {
      contentLanguage: 'en',
      feedLabel: args.feedLabel,
      offerId: args.offerId,
      productAttributes: {
        availability: 'IN_STOCK',
        description: 'Description',
        imageLink: 'https://example.com/image.jpg',
        link: `https://example.com/${args.offerId}`,
        price: { amountMicros: '1000000', currencyCode: 'USD' },
        title: args.offerId,
      },
    },
    sourceVersion: '1',
  })

const artifactFeed = (): GmcArtifactFeedConfig => {
  let stored: Awaited<ReturnType<GmcArtifactFeedConfig['artifactStore']['read']>> = null
  return {
    id: 'us-primary',
    access: 'public',
    artifactStore: {
      promote: vi.fn(() => Promise.resolve('promoted' as const)),
      put: vi.fn((args) => {
        stored = { body: args.body, descriptor: args.descriptor }
        return Promise.resolve()
      }),
      read: vi.fn(() => Promise.resolve(stored)),
      readCurrent: vi.fn(() => Promise.resolve(null)),
      readCurrentDescriptor: vi.fn(() => Promise.resolve(null)),
    },
    delivery: 'artifact',
    path: '/feeds/google-us.tsv',
    selector: { contentLanguage: 'en', feedLabel: 'US' },
  }
}

describe('canonical feed builds', () => {
  it('pins each artifact to one feed language/label selector', async () => {
    const feed = artifactFeed()
    const built = await buildCanonicalFeed({
      feed,
      generatedAt: '2026-08-29T12:00:00.000Z',
      products: [
        product({ feedLabel: 'CA', offerId: 'ca-1' }),
        product({ feedLabel: 'US', offerId: 'us-1' }),
      ],
    })
    const output = new TextDecoder().decode(built.body)

    expect(built.productCount).toBe(1)
    expect(output).toContain('us-1')
    expect(output).not.toContain('ca-1')
  })

  it('stores an immutable artifact before atomically promoting it', async () => {
    const feed = artifactFeed()
    await publishFeedArtifact({
      feed,
      generatedAt: '2026-08-29T12:00:00.000Z',
      instanceId: 'store-a',
      products: [product({ feedLabel: 'US', offerId: 'us-1' })],
      sourceVersion: '42',
    })

    expect(feed.artifactStore.put).toHaveBeenCalledOnce()
    expect(feed.artifactStore.read).toHaveBeenCalledOnce()
    expect(feed.artifactStore.promote).toHaveBeenCalledOnce()
    expect(vi.mocked(feed.artifactStore.put).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(feed.artifactStore.promote).mock.invocationCallOrder[0],
    )
    expect(vi.mocked(feed.artifactStore.read).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(feed.artifactStore.promote).mock.invocationCallOrder[0],
    )
  })

  it('leaves the last-known-good pointer untouched when a build write fails', async () => {
    const feed = artifactFeed()
    vi.mocked(feed.artifactStore.put).mockRejectedValueOnce(new Error('object storage unavailable'))

    await expect(
      publishFeedArtifact({
        feed,
        instanceId: 'store-a',
        products: [product({ feedLabel: 'US', offerId: 'us-1' })],
        sourceVersion: '42',
      }),
    ).rejects.toThrow('object storage unavailable')
    expect(feed.artifactStore.promote).not.toHaveBeenCalled()
  })

  it('leaves the last-known-good pointer untouched when immutable read-back is corrupted', async () => {
    const feed = artifactFeed()
    vi.mocked(feed.artifactStore.read).mockResolvedValueOnce({
      body: new TextEncoder().encode('corrupted'),
      descriptor: {
        byteLength: 9,
        checksum: '0'.repeat(64),
        contentType: 'text/tab-separated-values',
        createdAt: '2026-08-29T12:00:00.000Z',
        key: 'wrong/object.tsv',
        sourceVersion: '42',
      },
    })

    await expect(
      publishFeedArtifact({
        feed,
        instanceId: 'store-a',
        products: [product({ feedLabel: 'US', offerId: 'us-1' })],
        sourceVersion: '42',
      }),
    ).rejects.toThrow(/checksum|descriptor/i)
    expect(feed.artifactStore.promote).not.toHaveBeenCalled()
  })

  it('refuses promotion when immutable read-back changes the source-version fence', async () => {
    const feed = artifactFeed()
    const read = vi.mocked(feed.artifactStore.read)
    const put = vi.mocked(feed.artifactStore.put)
    put.mockImplementationOnce((args) => {
      read.mockResolvedValueOnce({
        body: args.body,
        descriptor: { ...args.descriptor, sourceVersion: '43' },
      })
      return Promise.resolve()
    })

    await expect(
      publishFeedArtifact({
        feed,
        generatedAt: '2026-08-29T12:00:00.000Z',
        instanceId: 'store-a',
        products: [product({ feedLabel: 'US', offerId: 'us-1' })],
        sourceVersion: '42',
      }),
    ).rejects.toThrow(/sourceVersion/i)
    expect(feed.artifactStore.promote).not.toHaveBeenCalled()
  })

  it.each([
    ['content type', { contentType: 'text/plain\r\nX-Evil: yes', extension: 'txt' }],
    ['extension', { contentType: 'text/plain', extension: '../txt' }],
  ])('rejects unsafe custom format %s before artifact storage', async (_name, metadata) => {
    const feed = artifactFeed()
    feed.format = {
      id: 'custom',
      serialize: () => ({ body: new Uint8Array([1]), ...metadata }),
    }

    await expect(
      publishFeedArtifact({
        feed,
        instanceId: 'store-a',
        products: [product({ feedLabel: 'US', offerId: 'us-1' })],
        sourceVersion: '42',
      }),
    ).rejects.toThrow(/invalid (content type|file extension)/i)
    expect(feed.artifactStore.put).not.toHaveBeenCalled()
  })

  it('fails closed before serving or promoting a feed outside explicit memory bounds', async () => {
    const productValue = product({ feedLabel: 'US', offerId: 'us-1' })
    const countBound = artifactFeed()
    countBound.limits = { maxProducts: 1, maxSerializedBytes: 1_000_000 }
    await expect(
      buildCanonicalFeed({
        feed: countBound,
        products: [productValue, product({ feedLabel: 'US', offerId: 'us-2' })],
      }),
    ).rejects.toThrow(/product safety limit/i)

    const byteBound = artifactFeed()
    byteBound.limits = { maxProducts: 10, maxSerializedBytes: 10 }
    await expect(
      publishFeedArtifact({
        feed: byteBound,
        instanceId: 'store-a',
        products: [productValue],
        sourceVersion: '42',
      }),
    ).rejects.toThrow(/byte safety limit/i)
    expect(byteBound.artifactStore.put).not.toHaveBeenCalled()
    expect(byteBound.artifactStore.promote).not.toHaveBeenCalled()
  })

  it('rejects a corrupted object-store artifact before it can be served', () => {
    const body = new TextEncoder().encode('canonical feed')

    expect(() =>
      assertFeedArtifactIntegrity({
        body,
        descriptor: {
          byteLength: body.byteLength,
          checksum: '0'.repeat(64),
          contentType: 'text/tab-separated-values',
          createdAt: '2026-08-29T12:00:00.000Z',
          key: 'feed/corrupt.tsv',
          sourceVersion: '42',
        },
      }),
    ).toThrow(/checksum/i)
  })

  it.each([
    ['content type', { contentType: 'text/plain\r\nX-Evil: yes' }],
    ['untrimmed content type', { contentType: ' text/plain' }],
    ['creation time', { createdAt: 'not-a-date' }],
    ['normalized invalid creation time', { createdAt: '2026-02-30T12:00:00Z' }],
    ['key', { key: 'feed/unsafe\u0000.tsv' }],
  ])('rejects invalid artifact %s metadata', (_name, override) => {
    const body = new TextEncoder().encode('canonical feed')
    const checksum = '55576192bbd9a5e6786677982f6729e1c0b870ac5861efcf92016d00ba5c9033'

    expect(() =>
      assertFeedArtifactIntegrity({
        body,
        descriptor: {
          byteLength: body.byteLength,
          checksum,
          contentType: 'text/tab-separated-values',
          createdAt: '2026-08-29T12:00:00.000Z',
          key: 'feed/canonical.tsv',
          sourceVersion: '42',
          ...override,
        },
      }),
    ).toThrow(/invalid/i)
  })

  it.each([
    ['another plugin instance', 'tenant-b/us-primary/42-'],
    ['another feed', 'tenant-a/secondary/42-'],
    ['descriptor metadata that does not match its key', 'tenant-a/us-primary/43-'],
  ])('rejects an otherwise valid artifact from %s', (_name, keyPrefix) => {
    const body = new TextEncoder().encode('canonical feed')
    const checksum = '55576192bbd9a5e6786677982f6729e1c0b870ac5861efcf92016d00ba5c9033'

    expect(() =>
      assertFeedArtifactIntegrity({
        body,
        descriptor: {
          byteLength: body.byteLength,
          checksum,
          contentType: 'text/tab-separated-values',
          createdAt: '2026-08-29T12:00:00.000Z',
          key: `${keyPrefix}${checksum}.tsv`,
          sourceVersion: '42',
        },
        feedId: 'us-primary',
        instanceId: 'tenant-a',
      }),
    ).toThrow(/outside the requested instance\/feed namespace/i)
  })

  it('rejects a normalized-invalid feed generation date', async () => {
    await expect(
      buildCanonicalFeed({
        feed: artifactFeed(),
        generatedAt: '2026-02-30T12:00:00Z',
        products: [product({ feedLabel: 'US', offerId: 'us-1' })],
      }),
    ).rejects.toThrow(/generatedAt.*ISO date/i)
  })

  it('uses source-versioned keys and reports a stale CAS promotion', async () => {
    const feed = artifactFeed()
    vi.mocked(feed.artifactStore.promote).mockResolvedValueOnce('stale')

    const result = await publishFeedArtifact({
      feed,
      generatedAt: '2026-08-29T12:00:00.000Z',
      instanceId: 'store-a',
      products: [product({ feedLabel: 'US', offerId: 'us-1' })],
      sourceVersion: '9001',
    })

    expect(result.promotion).toBe('stale')
    expect(result.artifact.key).toMatch(/^store-a\/us-primary\/9001-[a-f0-9]{64}\.tsv$/)
    expect(result.artifact.sourceVersion).toBe('9001')
  })

  it('passes the plugin instance namespace through every artifact-store boundary', async () => {
    const feed = artifactFeed()

    await publishFeedArtifact({
      feed,
      instanceId: 'tenant-b',
      products: [product({ feedLabel: 'US', offerId: 'us-1' })],
      sourceVersion: '42',
    })

    expect(feed.artifactStore.put).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'tenant-b' }),
    )
    expect(feed.artifactStore.read).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'tenant-b' }),
    )
    expect(feed.artifactStore.promote).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'tenant-b' }),
    )
  })
})
