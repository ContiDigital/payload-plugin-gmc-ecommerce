import type { CollectionConfig } from 'payload'

import type { AccessFn } from '../../types/index.js'
import type { GmcAsyncChildState } from '../types.js'

/** Durable ledger vocabulary; identical to the plugin's operation states. */
export const GMC_OPERATION_STATES: readonly GmcAsyncChildState[] = [
  'cancelled',
  'dead-lettered',
  'failed',
  'queued',
  'running',
  'succeeded',
]

/**
 * Ledger for the built-in Payload Jobs adapter.
 *
 * The `payload-jobs` collection cannot be the ledger: Payload deletes a job
 * after it succeeds (`deleteJobOnComplete` defaults to true), which would
 * destroy the immutable idempotency key, the aggregate workflow lineage, and
 * the audit history the adapter contract requires. This collection is written
 * exclusively by the plugin with `overrideAccess: true`; hosts only read it.
 */
export const buildGmcOperationsCollection = (args: {
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
    // The immutable dispatch key. Its unique index — not a read-then-insert —
    // is what makes duplicate dispatch return one operation.
    { name: 'key', type: 'text', index: true, required: true, unique: true },
    { name: 'subject', type: 'text', index: true, required: true },
    // Denormalized from the `gmc:<instanceId>:` subject namespace so status and
    // health reads stay indexed equality lookups instead of prefix scans.
    { name: 'instanceId', type: 'text', index: true },
    { name: 'commandType', type: 'text' },
    { name: 'command', type: 'json', required: true },
    { name: 'commandDigest', type: 'text' },
    { name: 'parentOperationId', type: 'text', index: true },
    { name: 'rootOperationId', type: 'text', index: true },
    { name: 'jobId', type: 'text' },
    {
      name: 'state',
      type: 'select',
      defaultValue: 'queued',
      index: true,
      options: GMC_OPERATION_STATES.map((state) => ({ label: state, value: state })),
      required: true,
    },
    { name: 'attempts', type: 'number', defaultValue: 0, required: true },
    { name: 'error', type: 'json' },
    { name: 'result', type: 'json' },
    { name: 'scheduledFor', type: 'date', index: true },
    { name: 'startedAt', type: 'date' },
    { name: 'finishedAt', type: 'date' },
  ],
  timestamps: true,
  versions: false,
})
