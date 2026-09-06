/** docs/v2-setup.md — "7. Multiple data sources". */
import type { PayloadGmcEcommerceV2Options } from 'payload-plugin-gmc-ecommerce'

export const extraSources: Pick<PayloadGmcEcommerceV2Options, 'additionalDataSourceIds'> = {
  additionalDataSourceIds: [process.env.GMC_EU_DATA_SOURCE_ID!],
}
