/** docs/v2-migration.md — "The projector you have to write". */
import type { GmcProductProjection, GmcProjectionArgs } from 'payload-plugin-gmc-ecommerce'

export const project = ({ doc }: GmcProjectionArgs): GmcProductProjection => {
  const product = doc as {
    category?: { googleCategoryId?: string }
    description?: string
    image?: { url?: string }
    inStock?: boolean
    price: number
    sku: string
    slug: string
    title: string
  }
  return {
    products: [
      {
        contentLanguage: 'en',
        feedLabel: 'US',
        offerId: product.sku,
        productAttributes: {
          availability: product.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
          condition: 'NEW',
          description: product.description,
          googleProductCategory: product.category?.googleCategoryId,
          imageLink: product.image?.url,
          link: `https://example.com/p/${product.slug}`,
          price: {
            amountMicros: String(Math.round(product.price * 1_000_000)),
            currencyCode: 'USD',
          },
          title: product.title,
        },
      },
    ],
  }
}
