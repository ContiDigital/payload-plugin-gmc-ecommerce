import type { CollectionConfig } from 'payload'

import { GMC_SYNC_LOG_SLUG } from '../constants.js'

export const buildGMCSyncLogCollection = (): CollectionConfig => ({
  slug: GMC_SYNC_LOG_SLUG,
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
      name: 'jobId',
      type: 'text',
      index: true,
      required: true,
      unique: true,
    },
    {
      name: 'type',
      type: 'select',
      options: [
        { label: 'Push', value: 'push' },
        { label: 'Pull', value: 'pull' },
        { label: 'Initial Sync', value: 'initialSync' },
        { label: 'Pull All', value: 'pullAll' },
        { label: 'Batch', value: 'batch' },
      ],
      required: true,
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'running',
      options: [
        { label: 'Running', value: 'running' },
        { label: 'Completed', value: 'completed' },
        { label: 'Failed', value: 'failed' },
        { label: 'Cancelled', value: 'cancelled' },
      ],
      required: true,
    },
    { name: 'total', type: 'number', defaultValue: 0 },
    { name: 'processed', type: 'number', defaultValue: 0 },
    { name: 'succeeded', type: 'number', defaultValue: 0 },
    { name: 'failed', type: 'number', defaultValue: 0 },
    { name: 'errors', type: 'json' },
    { name: 'startedAt', type: 'date', required: true },
    { name: 'completedAt', type: 'date' },
    { name: 'triggeredBy', type: 'text' },
    { name: 'metadata', type: 'json' },
  ],
})
