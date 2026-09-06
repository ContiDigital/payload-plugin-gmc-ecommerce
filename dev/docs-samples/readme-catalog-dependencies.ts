/** README.md — "Dependencies that change products". */
import type { PayloadGmcEcommerceV2Options } from 'payload-plugin-gmc-ecommerce'

import type { Promotion } from './_fixtures.js'

export const dependencies: Pick<
  PayloadGmcEcommerceV2Options,
  'catalogDependencies' | 'catalogGlobalDependencies'
> = {
  catalogDependencies: [
    {
      collection: 'promotions',
      // Only these fields matter; equal selections are ignored.
      select: ({ doc }) => ({
        ends: doc.ends,
        price: doc.price,
        starts: doc.starts,
        status: doc._status,
      }),
      // Optional: the exact products affected. Return null for a full sweep.
      resolveProductIds: ({ doc }) =>
        (doc as Promotion).products?.map((product) => product.id) ?? null,
      // Optional: future instants when the same data projects differently.
      scheduleAt: ({ doc }) =>
        [doc.starts, doc.ends].filter((value): value is string => typeof value === 'string'),
    },
  ],
  catalogGlobalDependencies: [
    { global: 'storeSettings', select: ({ doc }) => ({ freeShippingOver: doc.freeShippingOver }) },
  ],
}
