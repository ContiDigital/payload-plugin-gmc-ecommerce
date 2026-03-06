import type { Payload } from 'payload'

import { devUser } from './helpers/credentials.js'

export const seed = async (payload: Payload) => {
  // Seed admin user
  const { totalDocs: userCount } = await payload.count({
    collection: 'users',
    where: { email: { equals: devUser.email } },
  })

  if (!userCount) {
    await payload.create({
      collection: 'users',
      data: devUser,
    })
  }

  // Seed categories
  const { totalDocs: catCount } = await payload.count({ collection: 'categories' })

  if (!catCount) {
    const categories = [
      { name: 'Marble Statues', googleCategoryId: '500044' },
      { name: 'Bronze Sculptures', googleCategoryId: '500044' },
      { name: 'Garden Fountains', googleCategoryId: '985' },
      { name: 'Fireplace Mantels', googleCategoryId: '6321' },
      { name: 'Marble Tables', googleCategoryId: '6356' },
      { name: 'Memorial Statues', googleCategoryId: '500044' },
      { name: 'Bronze Planters & Vases', googleCategoryId: '594' },
      { name: 'Marble Busts', googleCategoryId: '500044' },
    ]

    for (const cat of categories) {
      await payload.create({ collection: 'categories', data: cat })
    }
  }

  // Seed products with MC attributes for push testing
  const { totalDocs: productCount } = await payload.count({ collection: 'products' })

  if (!productCount) {
    const products = [
      { title: 'Granite Motor Court Three Tiered Fountain', sku: 'MF-1329', price: 12500 },
      { title: 'Four Foot Tall Lion Statues in Solid Granite', sku: 'MS-1197', price: 8900 },
      { title: 'Rare French Louis XV Mantel in Exotic Orobico Rosso Marble', sku: 'MFP-2602', price: 45000 },
      { title: 'Ladies and Lions Classic Bronze Fountain', sku: 'BF-748', price: 18500 },
      { title: 'Abstract Marble Statue and Base', sku: 'MS-1596', price: 6200 },
      { title: 'Sea Turtles Mailbox in Brilliant Blue', sku: 'BS-1659', price: 2400 },
      { title: 'Lion Statue Pair in Hand Carved Italian Ivory Travertine', sku: 'MS-1333', price: 15800 },
      { title: 'Onyx / Wood Table', sku: 'MT-272', price: 3200 },
      { title: 'White Marble Angel Memorial Statue', sku: 'MEM-519', price: 9500 },
      { title: 'Figural Female Marble Lamp Post Pair', sku: 'MS-1383', price: 22000 },
      { title: 'Europa Bronze Cherub Garland Vase Pair', sku: 'BP-1198', price: 7800 },
      { title: 'Statuary White Marble Cherub Themed Planter Pair', sku: 'MP-521', price: 5600 },
      { title: 'Exquisite Solid French Style Mantel In Italian Bianco Perlino Marble', sku: 'MFP-2704', price: 38000 },
      { title: 'Playful Children on Tree Stump Bronze Statue', sku: 'BS-1517', price: 4800 },
      { title: 'Bronze Manatee Mailbox', sku: 'BS-1715', price: 1800 },
      { title: '75" Tall Elk Statue in Bronze', sku: 'BS-1783', price: 14200 },
      { title: 'Statue Pair of Rearing Bronze Horses', sku: 'BS-1717', price: 28000 },
      { title: 'French Style Mantel in Arabascato Orobico Rosso Italian Marble', sku: 'MFP-2600', price: 52000 },
      { title: 'Contemporary Style Three Tiered Fountain in Statuary White Marble', sku: 'MF-2184', price: 16500 },
      { title: 'Clean French Marble Fireplace Mantel with Shell Motif', sku: 'MFP-2253', price: 19800 },
      { title: 'Bolection Style Mantel in Rare Exotic Italian Arabascato Rosso', sku: 'MFP-2654', price: 65000 },
      { title: 'Arched Style Carrara Marble Fireplace Mantel', sku: 'MFP-2460', price: 24500 },
      { title: 'Pristine White French Style Marble Fireplace Mantel', sku: 'MFP-1897', price: 21000 },
      { title: '62 Inch Bronze Dolphins Fountain', sku: 'BF-760', price: 11200 },
      { title: 'Deep Relief French Style Mantel in Italian Botticino Marble', sku: 'MFP-2634', price: 35000 },
      { title: 'Enamel Bronze Statue - Dolphin, Sea Turtle, Tropical Fish and Stingray Table Decor', sku: 'BS-1688', price: 3400 },
      { title: 'Three Tiered Light Travertine Fountain', sku: 'MF-2111', price: 8900 },
      { title: 'Arabascato Marble Bust of a Roman Soldier', sku: 'MBT-517', price: 4200 },
      { title: 'Three Tier Fountain in Antique Griggio Granite', sku: 'MF-1639', price: 14800 },
      { title: 'Marble Immaculate Conception Virgin Mary Statue', sku: 'MS-995', price: 7500 },
      { title: 'Marble Lion Pair In Italian "Perlino"', sku: 'MS-1334', price: 16200 },
      { title: 'Oversized Figural Maidens with Rose Garlands Mantel in Italian Ivory Travertine', sku: 'MFP-2695', price: 65000 },
    ]

    for (const product of products) {
      const priceMicros = String(product.price * 1_000_000)

      await payload.create({
        collection: 'products',
        data: {
          ...product,
          availability: 'in_stock',
          merchantCenter: {
            enabled: true,
            identity: {
              offerId: product.sku,
            },
            productAttributes: {
              availability: 'IN_STOCK',
              condition: 'NEW',
              imageLink: `https://www.finesgallery.com/images/products/${product.sku.toLowerCase()}.jpg`,
              link: `https://www.finesgallery.com/product/${product.sku.toLowerCase()}`,
              price: {
                amountMicros: priceMicros,
                currencyCode: 'USD',
              },
              title: product.title,
            },
          },
        },
      })
    }
  }
}
