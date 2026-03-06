import type { CollectionConfig } from 'payload'

import { GMC_FIELD_MAPPINGS_SLUG } from '../constants.js'

export const buildGMCFieldMappingsCollection = (): CollectionConfig => ({
  slug: GMC_FIELD_MAPPINGS_SLUG,
  // Restrict direct REST/GraphQL/admin access — the plugin manages this
  // collection internally via overrideAccess: true on its endpoints
  access: {
    create: () => false,
    delete: () => false,
    read: ({ req }) => Boolean(req.user),
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
