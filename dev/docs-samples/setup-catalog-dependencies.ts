/** docs/v2-setup.md — "4. Dependencies that change products". */
import type { PayloadGmcEcommerceV2Options } from 'payload-plugin-gmc-ecommerce'

import type { Promotion } from './_fixtures.js'

export const dependencyOptions: Pick<
  PayloadGmcEcommerceV2Options,
  'catalogDependencies' | 'catalogGlobalDependencies'
> = {
  catalogDependencies: [
    {
      collection: 'promotions',
      // Only these fields affect projection; an equal selection dispatches nothing.
      select: ({ doc }) => ({
        ends: doc.ends,
        price: doc.price,
        starts: doc.starts,
        status: doc._status,
      }),
      // The products actually affected. Return null for a full catalog sweep.
      resolveProductIds: ({ doc }) =>
        (doc as Promotion).products?.map((product) => product.id) ?? null,
      // Future instants at which the same data projects differently.
      scheduleAt: ({ doc }) =>
        [doc.starts, doc.ends].filter((value): value is string => typeof value === 'string'),
    },
  ],
  catalogGlobalDependencies: [
    {
      global: 'storeSettings',
      select: ({ doc }) => ({ freeShippingOver: doc.freeShippingOver }),
    },
  ],
}
