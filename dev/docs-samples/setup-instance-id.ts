/** docs/v2-setup.md — "8. Two installations in one process". */
import type { PayloadGmcEcommerceV2Options } from 'payload-plugin-gmc-ecommerce'

import { payloadJobsAsyncAdapter } from 'payload-plugin-gmc-ecommerce'

export const secondInstall: Pick<
  PayloadGmcEcommerceV2Options,
  'async' | 'instanceId' | 'publicationState'
> = {
  instanceId: 'gmc-us',
  publicationState: { collectionSlug: 'gmc-publications-us' },
  async: payloadJobsAsyncAdapter({ collectionSlug: 'gmc-operations-us', queue: 'gmc-us' }),
}
