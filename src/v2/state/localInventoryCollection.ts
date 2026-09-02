import type { CollectionConfig } from 'payload'

import type { AccessFn } from '../../types/index.js'

const LOCAL_INVENTORY_PUBLICATION_STATUSES = ['failed', 'publish-pending', 'published'] as const

/**
 * Internal durable fence for Google's whole-resource LocalInventory writes.
 * One row exists per Merchant identity/store; users never edit this read model.
 */
export const buildGmcLocalInventoryPublicationCollection = (args: {
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
    { name: 'merchantId', type: 'text', index: true, required: true },
    { name: 'dataSourceName', type: 'text', index: true, required: true },
    { name: 'contentLanguage', type: 'text', index: true, required: true },
    { name: 'feedLabel', type: 'text', index: true, required: true },
    { name: 'offerId', type: 'text', index: true, required: true },
    { name: 'storeCode', type: 'text', index: true, required: true },
    { name: 'productId', type: 'text', index: true, required: true },
    {
      name: 'status',
      type: 'select',
      index: true,
      options: LOCAL_INVENTORY_PUBLICATION_STATUSES.map((status) => ({
        label: status,
        value: status,
      })),
      required: true,
    },
    { name: 'operationId', type: 'text', index: true, required: true },
    { name: 'revision', type: 'number', defaultValue: 0, index: true, required: true },
    { name: 'desiredAt', type: 'date', index: true, required: true },
    { name: 'desiredDigest', type: 'text', required: true },
    { name: 'desiredVersion', type: 'text', index: true, required: true },
    { name: 'publishedDigest', type: 'text' },
    { name: 'publishedVersion', type: 'text' },
    { name: 'publishedAt', type: 'date' },
    { name: 'error', type: 'json' },
  ],
  timestamps: true,
  versions: false,
})
