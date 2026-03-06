import type { CollectionConfig, Config, Field, TabsField } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import { MC_FIELD_GROUP_NAME, PLUGIN_SLUG } from '../constants.js'

// ---------------------------------------------------------------------------
// Merchant Center fields that get injected into the products collection
// ---------------------------------------------------------------------------

const buildMerchantCenterFields = (options: NormalizedPluginOptions): Field => ({
  name: MC_FIELD_GROUP_NAME,
  type: 'group',
  admin: {
    description: 'Google Merchant Center product data',
  },
  fields: [
    // --- Enable toggle ---
    {
      name: 'enabled',
      type: 'checkbox',
      admin: {
        description: 'Enable Merchant Center sync for this product',
      },
      defaultValue: false,
    },

    // --- Identity ---
    {
      name: 'identity',
      type: 'group',
      admin: {
        condition: (_, siblingData) => siblingData?.enabled,
        description: 'Product identity in Google Merchant Center',
      },
      fields: [
        {
          name: 'offerId',
          type: 'text',
          admin: {
            description: `Auto-populated from "${options.collections.products.identityField}" if left blank`,
          },
        },
        {
          name: 'contentLanguage',
          type: 'text',
          admin: { placeholder: options.defaults.contentLanguage },
        },
        {
          name: 'feedLabel',
          type: 'text',
          admin: { placeholder: options.defaults.feedLabel },
        },
        {
          name: 'dataSourceOverride',
          type: 'text',
          admin: {
            condition: () => true,
            description: 'Override the default data source for this product',
          },
        },
      ],
    },

    // --- Product Attributes ---
    {
      name: 'productAttributes',
      type: 'group',
      admin: {
        condition: (_, siblingData) => siblingData?.enabled,
        description: 'Product attributes sent to Google Merchant Center',
      },
      fields: [
        // Basic Info
        { name: 'title', type: 'text' },
        { name: 'description', type: 'textarea' },
        { name: 'link', type: 'text' },
        { name: 'mobileLink', type: 'text' },
        { name: 'canonicalLink', type: 'text' },
        { name: 'imageLink', type: 'text' },
        {
          name: 'additionalImageLinks',
          type: 'array',
          dbName: 'mc_addl_img_links',
          fields: [{ name: 'url', type: 'text', required: true }],
        },

        // Price
        {
          name: 'price',
          type: 'group',
          fields: [
            {
              name: 'amountMicros',
              type: 'text',
              admin: { description: 'Price in micros (e.g., "15990000" = $15.99)' },
            },
            { name: 'currencyCode', type: 'text', admin: { placeholder: options.defaults.currency } },
          ],
        },
        {
          name: 'salePrice',
          type: 'group',
          fields: [
            { name: 'amountMicros', type: 'text' },
            { name: 'currencyCode', type: 'text' },
          ],
        },
        {
          name: 'salePriceEffectiveDate',
          type: 'group',
          fields: [
            { name: 'startDate', type: 'date' },
            { name: 'endDate', type: 'date' },
          ],
        },
        {
          name: 'costOfGoodsSold',
          type: 'group',
          fields: [
            { name: 'amountMicros', type: 'text' },
            { name: 'currencyCode', type: 'text' },
          ],
        },

        // Categorization
        {
          name: 'googleProductCategory',
          type: 'text',
          admin: { description: 'Google product taxonomy ID or full category path' },
        },
        {
          name: 'productTypes',
          type: 'array',
          dbName: 'mc_product_types',
          fields: [{ name: 'value', type: 'text', required: true }],
        },
        { name: 'brand', type: 'text' },
        {
          name: 'gtins',
          type: 'array',
          dbName: 'mc_gtins',
          fields: [{ name: 'value', type: 'text', required: true }],
        },
        { name: 'mpn', type: 'text' },
        { name: 'identifierExists', type: 'checkbox' },

        // Product Details
        {
          name: 'condition',
          type: 'select',
          options: [
            { label: 'New', value: 'NEW' },
            { label: 'Used', value: 'USED' },
            { label: 'Refurbished', value: 'REFURBISHED' },
          ],
        },
        { name: 'adult', type: 'checkbox' },
        {
          name: 'ageGroup',
          type: 'select',
          options: [
            { label: 'Newborn', value: 'newborn' },
            { label: 'Infant', value: 'infant' },
            { label: 'Toddler', value: 'toddler' },
            { label: 'Kids', value: 'kids' },
            { label: 'Adult', value: 'adult' },
          ],
        },
        {
          name: 'availability',
          type: 'select',
          options: [
            { label: 'In Stock', value: 'IN_STOCK' },
            { label: 'Out of Stock', value: 'OUT_OF_STOCK' },
            { label: 'Preorder', value: 'PREORDER' },
            { label: 'Backorder', value: 'BACKORDER' },
          ],
        },
        { name: 'availabilityDate', type: 'date' },
        { name: 'color', type: 'text' },
        {
          name: 'gender',
          type: 'select',
          options: [
            { label: 'Male', value: 'male' },
            { label: 'Female', value: 'female' },
            { label: 'Unisex', value: 'unisex' },
          ],
        },
        { name: 'material', type: 'text' },
        { name: 'pattern', type: 'text' },
        { name: 'size', type: 'text' },
        {
          name: 'sizeType',
          type: 'select',
          options: [
            { label: 'Regular', value: 'regular' },
            { label: 'Petite', value: 'petite' },
            { label: 'Plus', value: 'plus' },
            { label: 'Tall', value: 'tall' },
            { label: 'Maternity', value: 'maternity' },
          ],
        },
        { name: 'sizeSystem', type: 'text' },
        { name: 'itemGroupId', type: 'text' },

        // Dimensions
        ...buildDimensionField('productWeight'),
        ...buildDimensionField('productLength'),
        ...buildDimensionField('productWidth'),
        ...buildDimensionField('productHeight'),

        // Shipping
        {
          name: 'shipping',
          type: 'array',
          dbName: 'mc_shipping',
          fields: [
            { name: 'country', type: 'text' },
            { name: 'region', type: 'text' },
            { name: 'service', type: 'text' },
            {
              name: 'price',
              type: 'group',
              fields: [
                { name: 'amountMicros', type: 'text' },
                { name: 'currencyCode', type: 'text' },
              ],
            },
          ],
        },
        ...buildDimensionField('shippingWeight'),
        ...buildDimensionField('shippingLength'),
        ...buildDimensionField('shippingWidth'),
        ...buildDimensionField('shippingHeight'),
        {
          name: 'freeShippingThreshold',
          type: 'array',
          dbName: 'mc_free_ship_thresh',
          fields: [
            { name: 'country', type: 'text' },
            {
              name: 'priceThreshold',
              type: 'group',
              fields: [
                { name: 'amountMicros', type: 'text' },
                { name: 'currencyCode', type: 'text' },
              ],
            },
          ],
        },

        // Tax
        {
          name: 'taxes',
          type: 'array',
          dbName: 'mc_taxes',
          fields: [
            { name: 'country', type: 'text' },
            { name: 'region', type: 'text' },
            { name: 'rate', type: 'number' },
            { name: 'taxShip', type: 'checkbox' },
          ],
        },

        // Custom Labels
        { name: 'customLabel0', type: 'text' },
        { name: 'customLabel1', type: 'text' },
        { name: 'customLabel2', type: 'text' },
        { name: 'customLabel3', type: 'text' },
        { name: 'customLabel4', type: 'text' },

        // Additional
        { name: 'multipack', type: 'number' },
        { name: 'isBundle', type: 'checkbox' },
        { name: 'energyEfficiencyClass', type: 'text' },
        { name: 'minEnergyEfficiencyClass', type: 'text' },
        { name: 'maxEnergyEfficiencyClass', type: 'text' },
        {
          name: 'promotionIds',
          type: 'array',
          dbName: 'mc_promo_ids',
          fields: [{ name: 'value', type: 'text', required: true }],
        },
        {
          name: 'excludedDestinations',
          type: 'array',
          dbName: 'mc_excl_dests',
          fields: [{ name: 'value', type: 'text', required: true }],
        },
        {
          name: 'includedDestinations',
          type: 'array',
          dbName: 'mc_incl_dests',
          fields: [{ name: 'value', type: 'text', required: true }],
        },
        { name: 'externalSellerId', type: 'text' },
        { name: 'pause', type: 'text' },
      ],
    },

    // --- Custom Attributes ---
    {
      name: 'customAttributes',
      type: 'array',
      admin: {
        condition: (_, siblingData) => siblingData?.enabled,
        description: 'Custom key-value attributes',
      },
      dbName: 'mc_custom_attrs',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'value', type: 'text', required: true },
      ],
    },

    // --- Snapshot (read-only) ---
    {
      name: 'snapshot',
      type: 'json',
      admin: {
        condition: (_, siblingData) => siblingData?.enabled,
        description: 'Last known processed state from Google Merchant Center (read-only)',
        readOnly: true,
      },
    },

    // --- Sync Metadata (read-only) ---
    {
      name: 'syncMeta',
      type: 'group',
      admin: {
        condition: (_, siblingData) => siblingData?.enabled,
        readOnly: true,
      },
      fields: [
        {
          name: 'state',
          type: 'select',
          defaultValue: 'idle',
          options: [
            { label: 'Idle', value: 'idle' },
            { label: 'Syncing', value: 'syncing' },
            { label: 'Success', value: 'success' },
            { label: 'Error', value: 'error' },
          ],
        },
        { name: 'lastAction', type: 'text' },
        { name: 'lastSyncedAt', type: 'date' },
        { name: 'lastError', type: 'textarea' },
        {
          name: 'syncSource',
          type: 'select',
          options: [
            { label: 'Push', value: 'push' },
            { label: 'Pull', value: 'pull' },
            { label: 'Initial', value: 'initial' },
          ],
        },
        {
          name: 'dirty',
          type: 'checkbox',
          admin: { readOnly: true },
          defaultValue: false,
        },
      ],
    },
  ],
})

// ---------------------------------------------------------------------------
// Dimension field builder helper
// ---------------------------------------------------------------------------

const buildDimensionField = (name: string): Field[] => [
  {
    name,
    type: 'group',
    fields: [
      { name: 'value', type: 'number' },
      { name: 'unit', type: 'text', admin: { placeholder: 'in' } },
    ],
  },
]

// ---------------------------------------------------------------------------
// Tab builder for the Merchant Center tab
// ---------------------------------------------------------------------------

const buildMerchantCenterTab = (options: NormalizedPluginOptions) => ({
  fields: [
    // UI-only component field for sync controls
    {
      name: 'gmcSyncControls',
      type: 'ui' as const,
      admin: {
        components: {
          Field: `${PLUGIN_SLUG}/client#MerchantCenterSyncControls`,
        },
      },
    },
    buildMerchantCenterFields(options),
  ],
  label: 'Merchant Center',
})

// ---------------------------------------------------------------------------
// Public: exported helper for manual tab placement
// ---------------------------------------------------------------------------

export const getMerchantCenterTab = (options: NormalizedPluginOptions) =>
  buildMerchantCenterTab(options)

export const getMerchantCenterField = (options: NormalizedPluginOptions) =>
  buildMerchantCenterFields(options)

// ---------------------------------------------------------------------------
// Placeholder field for manual placement
// ---------------------------------------------------------------------------

export const MerchantCenterUIPlaceholder: Field = {
  name: 'gmcPlaceholder',
  type: 'ui' as const,
  admin: {
    components: {
      Field: `${PLUGIN_SLUG}/client#MerchantCenterSyncControls`,
    },
  },
}

// ---------------------------------------------------------------------------
// Apply collection enhancements
// ---------------------------------------------------------------------------

export const applyCollectionEnhancements = (
  config: Config,
  options: NormalizedPluginOptions,
): Config => {
  if (!config.collections) {
    config.collections = []
  }

  const productCollectionSlug = options.collections.products.slug
  const productCollection = config.collections.find(
    (c: CollectionConfig) => c.slug === productCollectionSlug,
  )

  if (!productCollection) {
    throw new Error(
      `${PLUGIN_SLUG}: Collection "${productCollectionSlug}" not found in config. ` +
      'Ensure it is defined before the plugin is applied.',
    )
  }

  if (options.collections.products.autoInjectTab) {
    injectMerchantCenterTab(productCollection, options)
  }

  return config
}

// ---------------------------------------------------------------------------
// Tab injection logic
// ---------------------------------------------------------------------------

const injectMerchantCenterTab = (
  collection: CollectionConfig,
  options: NormalizedPluginOptions,
): void => {
  const mcTab = buildMerchantCenterTab(options)

  // Look for an existing tabs field
  const existingTabsIndex = collection.fields.findIndex(
    (f): f is TabsField => 'type' in f && f.type === 'tabs',
  )

  if (existingTabsIndex !== -1) {
    const existingTabs = collection.fields[existingTabsIndex] as TabsField

    // Check for placeholder replacement
    const placeholderIndex = existingTabs.tabs.findIndex(
      (tab) =>
        'fields' in tab &&
        tab.fields.some(
          (f) => 'name' in f && f.name === 'gmcPlaceholder',
        ),
    )

    if (placeholderIndex !== -1) {
      existingTabs.tabs[placeholderIndex] = mcTab
    } else {
      const position = options.collections.products.tabPosition
      if (position === 'before-last' && existingTabs.tabs.length > 0) {
        existingTabs.tabs.splice(existingTabs.tabs.length - 1, 0, mcTab)
      } else if (typeof position === 'number') {
        existingTabs.tabs.splice(position, 0, mcTab)
      } else {
        existingTabs.tabs.push(mcTab)
      }
    }
  } else {
    // No existing tabs — wrap all fields in a "General" tab, add MC tab
    const existingFields = [...collection.fields]
    collection.fields = [
      {
        type: 'tabs',
        tabs: [
          {
            fields: existingFields,
            label: 'General',
          },
          mcTab,
        ],
      },
    ]
  }
}
