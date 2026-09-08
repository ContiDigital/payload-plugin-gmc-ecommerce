/** README.md — "Quick start". */
import { buildConfig } from 'payload'
import { payloadGmcEcommerce, payloadJobsAsyncAdapter } from 'payload-plugin-gmc-ecommerce'

import type { Product } from './_fixtures.js'

import { db, Products } from './_fixtures.js'

export default buildConfig({
  // Host scaffolding the doc block omits.
  db,
  secret: process.env.PAYLOAD_SECRET!,
  collections: [Products],
  jobs: {
    tasks: [], // The plugin appends its task; required by Payload 3.37.
    // Runs queued Merchant commands every minute. Not for serverless hosts;
    // there, call payload.jobs.run({ queue: 'gmc', sequential: true }) from a
    // cron endpoint.
    autoRun: [{ cron: '* * * * *', limit: 25, queue: 'gmc' }],
  },
  plugins: [
    payloadGmcEcommerce({
      merchantId: process.env.GMC_MERCHANT_ID!,
      dataSourceId: process.env.GMC_DATA_SOURCE_ID!,
      getCredentials: async () => ({
        type: 'json',
        credentials: JSON.parse(process.env.GMC_SERVICE_ACCOUNT_JSON!),
      }),

      async: payloadJobsAsyncAdapter({ queue: 'gmc' }),

      products: {
        collection: 'products',
        where: { _status: { equals: 'published' } },

        // Every Google offer a document owns. Must work on a deleted document too.
        resolveIdentities: ({ doc }) => [
          { contentLanguage: 'en', feedLabel: 'US', offerId: String(doc.sku) },
        ],

        // The complete ProductInput. Return products: [] to remove the offer.
        project: ({ doc }) => {
          const product = doc as Product // your generated Payload type
          return {
            products: [
              {
                contentLanguage: 'en',
                feedLabel: 'US',
                offerId: product.sku,
                productAttributes: {
                  availability: product.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
                  brand: 'Example',
                  condition: 'NEW',
                  description: product.description,
                  imageLink: product.image?.url,
                  link: `https://example.com/products/${product.slug}`,
                  price: {
                    amountMicros: String(Math.round(product.price * 1_000_000)),
                    currencyCode: 'USD',
                  },
                  title: product.title,
                },
              },
            ],
          }
        },
      },
    }),
  ],
})
