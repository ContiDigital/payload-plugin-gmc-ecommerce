/** README.md — "Feeds (optional)". */
import type { PayloadGmcEcommerceV2Options } from 'payload-plugin-gmc-ecommerce'

export const feedOptions: Pick<PayloadGmcEcommerceV2Options, 'feeds'> = {
  feeds: [
    {
      id: 'google-us',
      access: 'public',
      // or 'artifact' with an artifactStore for large catalogs
      delivery: 'dynamic',
      path: '/feeds/google-us.tsv',
      selector: { contentLanguage: 'en', feedLabel: 'US' },
    },
  ],
}
