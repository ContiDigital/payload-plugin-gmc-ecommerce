import type { CollectionConfig } from 'payload'

import type { AccessFn } from '../types/index.js'

import { GMC_FIELD_MAPPINGS_SLUG } from '../constants.js'
import { hasDefaultPluginAccess } from '../server/utilities/access.js'

export const buildGMCFieldMappingsCollection = (accessFn?: AccessFn): CollectionConfig => ({
  slug: GMC_FIELD_MAPPINGS_SLUG,
  // Restrict direct REST/GraphQL/admin access — plugin endpoints and internal
  // service code use overrideAccess where necessary.
  access: {
    create: () => false,
    delete: () => false,
    read: async ({ req }) => {
      if (!req.user) { return false }
      if (accessFn) {
        return accessFn({ payload: req.payload, req, user: req.user })
      }
      return hasDefaultPluginAccess(req.user)
    },
    update: () => false,
  },
  admin: {
    hidden: true,
  },
  fields: [
    {
      name: 'source',
      type: 'text',
      index: true,
      required: true,
    },
    {
      name: 'target',
      type: 'text',
      required: true,
    },
    {
      name: 'syncMode',
      type: 'select',
      defaultValue: 'initialOnly',
      options: [
        { label: 'Permanent', value: 'permanent' },
        { label: 'Initial Only', value: 'initialOnly' },
      ],
      required: true,
    },
    {
      name: 'transformPreset',
      type: 'select',
      defaultValue: 'none',
      options: [
        { label: 'None', value: 'none' },
        { label: 'To Micros (number)', value: 'toMicros' },
        { label: 'To Micros (string)', value: 'toMicrosString' },
        { label: 'Extract URL', value: 'extractUrl' },
        { label: 'Extract Absolute URL', value: 'extractAbsoluteUrl' },
        { label: 'To Array', value: 'toArray' },
        { label: 'To String', value: 'toString' },
        { label: 'To Boolean', value: 'toBoolean' },
      ],
    },
    {
      name: 'order',
      type: 'number',
      defaultValue: 0,
    },
  ],
})
