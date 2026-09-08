/** README.md — "Local inventory (optional)". */
import type { PayloadGmcEcommerceV2Options } from 'payload-plugin-gmc-ecommerce'

export const localInventoryOptions: Pick<PayloadGmcEcommerceV2Options, 'localInventory'> = {
  localInventory: {
    storeCodes: ['MAIN'],
    project: ({ doc, storeCode }) => [
      {
        identity: { contentLanguage: 'en', feedLabel: 'US', offerId: String(doc.sku) },
        storeCode,
        inventory:
          Number(doc.stock) > 0
            ? {
                storeCode,
                localInventoryAttributes: {
                  availability: 'IN_STOCK',
                  quantity: String(doc.stock),
                },
              }
            : null, // null removes the store row
      },
    ],
  },
}
