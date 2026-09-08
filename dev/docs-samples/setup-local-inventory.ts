/** docs/v2-setup.md — "6. Local inventory (optional)". */
import type { PayloadGmcEcommerceV2Options } from 'payload-plugin-gmc-ecommerce'

export const localInventoryOptions: Pick<PayloadGmcEcommerceV2Options, 'localInventory'> = {
  localInventory: {
    storeCodes: ['MAIN'],
    // Codes you have stopped managing. Keep them here until one full
    // reconciliation has removed their inventory; the plugin emits deletes for
    // them without calling project().
    retiredStoreCodes: [],
    project: ({ doc, storeCode }) => [
      {
        identity: { contentLanguage: 'en', feedLabel: 'US', offerId: String(doc.sku) },
        storeCode,
        // null removes this store's row.
        inventory:
          Number(doc.stock) > 0
            ? {
                storeCode,
                localInventoryAttributes: {
                  availability: 'IN_STOCK',
                  quantity: String(doc.stock),
                },
              }
            : null,
      },
    ],
  },
}
