import fs from 'fs'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { payloadGmcEcommerceV2 } from 'payload-plugin-gmc-ecommerce/v2'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

import { testAsyncAdapter } from './helpers/testAsyncAdapter.js'
import { testEmailAdapter } from './helpers/testEmailAdapter.js'
import { seed } from './seed.js'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

if (!process.env.ROOT_DIR) {
  process.env.ROOT_DIR = dirname
}

const buildDatabaseUrl = (): string => {
  if (process.env.VITEST || process.env.VITEST_WORKER_ID) {
    const tmpDir = path.resolve(dirname, '.tmp')
    fs.mkdirSync(tmpDir, { recursive: true })

    const workerId = process.env.VITEST_WORKER_ID ?? process.pid.toString()
    return `file:${path.resolve(tmpDir, `vitest-${workerId}.db`)}`
  }

  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL
  }

  return 'file:./dev/dev-database.db'
}

export default buildConfig({
  admin: {
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [
    {
      slug: 'products',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'sku', type: 'text', required: true, unique: true },
        { name: 'price', type: 'number' },
        { name: 'description', type: 'textarea' },
        { name: 'imageUrl', type: 'text' },
        {
          name: 'availability',
          type: 'select',
          defaultValue: 'in_stock',
          options: [
            { label: 'In Stock', value: 'in_stock' },
            { label: 'Out of Stock', value: 'out_of_stock' },
          ],
        },
      ],
      versions: { drafts: true },
    },
    {
      // Not a Merchant product source. Wired only as a `catalogDependencies`
      // example: a change here can invalidate a product's projection without
      // changing the product's own row.
      slug: 'categories',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'googleCategoryId', type: 'text' },
      ],
    },
    {
      slug: 'media',
      fields: [],
      upload: {
        staticDir: path.resolve(dirname, 'media'),
      },
    },
  ],
  db: sqliteAdapter({
    client: {
      url: buildDatabaseUrl(),
    },
    // v2's automatic hooks require a real atomic canonical-write + outbox
    // boundary. Payload's SQLite adapter defaults transactions off.
    transactionOptions: {},
  }),
  editor: lexicalEditor(),
  email: testEmailAdapter,
  onInit: async (payload) => {
    await seed(payload)
  },
  plugins: [
    payloadGmcEcommerceV2({
      access: () => true,
      async: testAsyncAdapter,
      catalogDependencies: [
        {
          collection: 'categories',
          select: ({ doc }) => ({ name: doc.name, googleCategoryId: doc.googleCategoryId }),
        },
      ],
      dataSourceId: process.env.GOOGLE_MERCHANT_DATA_SOURCE_ID || '10621021803',
      disabled: !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      feeds: [
        {
          id: 'google-products',
          access: 'public',
          delivery: 'dynamic',
          format: 'tsv',
          path: '/feeds/google-products.tsv',
          selector: { contentLanguage: 'en', feedLabel: 'PRODUCTS' },
        },
      ],
      getCredentials: async () => ({
        credentials: {
          client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || 'test@test.iam.gserviceaccount.com',
          private_key: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || 'test-key',
        },
        type: 'json',
      }),
      merchantId: process.env.GOOGLE_MERCHANT_ID || '4791568',
      productIngestion: { mode: 'api-primary' },
      products: {
        collection: 'products',
        project: ({ doc }) => ({
          products: [
            {
              contentLanguage: 'en',
              feedLabel: 'PRODUCTS',
              offerId: String(doc.sku),
              productAttributes: {
                availability: doc.availability === 'in_stock' ? 'IN_STOCK' : 'OUT_OF_STOCK',
                description: String(doc.description ?? ''),
                imageLink: String(doc.imageUrl ?? ''),
                link: `https://example.test/products/${String(doc.sku)}`,
                price: {
                  amountMicros: String(Math.round(Number(doc.price ?? 0) * 1_000_000)),
                  currencyCode: 'USD',
                },
                title: String(doc.title),
              },
            },
          ],
        }),
        resolveIdentities: ({ doc }) => [
          { contentLanguage: 'en', feedLabel: 'PRODUCTS', offerId: String(doc.sku) },
        ],
      },
      workerAccess: () => false,
    }),
  ],
  secret: process.env.PAYLOAD_SECRET || 'gmc-plugin-dev-secret-key-12345',
  sharp,
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
})
