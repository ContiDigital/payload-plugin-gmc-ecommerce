import type { CollectionConfig } from 'payload'

import type { AccessFn } from '../../types/index.js'

import { GMC_PUBLICATION_STATUSES } from '../types.js'

export const buildGmcPublicationCollection = (args: {
  access: AccessFn
  slug: string
}): CollectionConfig => ({
  slug: args.slug,
  access: {
    create: () => false,
    delete: () => false,
    read: async ({ req }) => {
      if (!req.user) {
        return false
      }
      return args.access({ payload: req.payload, req, user: req.user })
    },
    update: () => false,
  },
  admin: { hidden: true },
  fields: [
    { name: 'key', type: 'text', index: true, required: true, unique: true },
    { name: 'merchantId', type: 'text', required: true },
    { name: 'dataSourceName', type: 'text', required: true },
    { name: 'contentLanguage', type: 'text', required: true },
    { name: 'feedLabel', type: 'text', required: true },
    { name: 'offerId', type: 'text', required: true },
    // Only `key`, `productId`, `status` and `storeCode` are ever queried. This
    // is a high-churn table, so every other column stays unindexed to keep the
    // compare-and-set write cheap.
    { name: 'productId', type: 'text', index: true },
    { name: 'storeCode', type: 'text', index: true },
    {
      name: 'status',
      type: 'select',
      index: true,
      options: GMC_PUBLICATION_STATUSES.map((status) => ({ label: status, value: status })),
      required: true,
    },
    { name: 'operationId', type: 'text', required: true },
    { name: 'revision', type: 'number', defaultValue: 0, required: true },
    { name: 'desiredAt', type: 'date' },
    { name: 'desiredDigest', type: 'text' },
    { name: 'publishedDigest', type: 'text' },
    { name: 'publishedAt', type: 'date' },
    { name: 'observedAt', type: 'date' },
    { name: 'remoteMissing', type: 'checkbox' },
    { name: 'remoteVersion', type: 'text' },
    { name: 'remoteStatus', type: 'json' },
    { name: 'error', type: 'json' },
  ],
  timestamps: true,
  versions: false,
})
