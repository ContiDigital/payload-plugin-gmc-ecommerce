import fs from 'fs'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { payloadGmcEcommerce } from 'payload-plugin-gmc-ecommerce'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

import { testEmailAdapter } from './helpers/testEmailAdapter.js'
import { seed } from './seed.js'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

if (!process.env.ROOT_DIR) {
  process.env.ROOT_DIR = dirname
}

const buildDatabaseUrl = (): string => {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL
  }

  if (process.env.VITEST || process.env.VITEST_WORKER_ID) {
    const tmpDir = path.resolve(dirname, '.tmp')
    fs.mkdirSync(tmpDir, { recursive: true })

    const workerId = process.env.VITEST_WORKER_ID ?? process.pid.toString()
    return `file:${path.resolve(tmpDir, `vitest-${workerId}.db`)}`
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
        { name: 'sku', type: 'text', required: true },
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
    },
    {
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
  }),
  editor: lexicalEditor(),
  email: testEmailAdapter,
  onInit: async (payload) => {
    await seed(payload)
  },
  plugins: [
    payloadGmcEcommerce({
      access: () => true,
      collections: {
        categories: {
          googleCategoryIdField: 'googleCategoryId',
          nameField: 'name',
          slug: 'categories',
        },
        products: {
          identityField: 'sku',
          slug: 'products',
          fieldMappings: [
            { source: 'title', target: 'productAttributes.title', syncMode: 'permanent' },
            { source: 'description', target: 'productAttributes.description', syncMode: 'initialOnly' },
            { source: 'price', target: 'productAttributes.price.amountMicros', syncMode: 'permanent', transformPreset: 'toMicrosString' },
            { source: 'imageUrl', target: 'productAttributes.imageLink', syncMode: 'initialOnly' },
          ],
        },
      },
      dataSourceId: process.env.GOOGLE_MERCHANT_DATA_SOURCE_ID || 'test-datasource',
      defaults: {
        contentLanguage: 'en',
        currency: 'USD',
        feedLabel: 'PRODUCTS',
      },
      getCredentials: async () => ({
        credentials: {
          client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || 'test@test.iam.gserviceaccount.com',
          private_key: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || 'test-key',
        },
        type: 'json',
      }),
      merchantId: process.env.GOOGLE_MERCHANT_ID || 'test-merchant-id',
      sync: {
        mode: 'manual',
        permanentSync: true,
      },
    }),
  ],
  secret: process.env.PAYLOAD_SECRET || 'gmc-plugin-dev-secret-key-12345',
  sharp,
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
})
