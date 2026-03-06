'use client'

import { useConfig } from '@payloadcms/ui'
import React from 'react'

export const MerchantCenterNavLink: React.FC = () => {
  const { config } = useConfig()
  const routes = config.routes as { admin?: string } | undefined
  const adminRoute = routes?.admin ?? '/admin'

  return (
    <a
      href={`${adminRoute}/merchant-center`}
      style={{
        color: 'inherit',
        display: 'block',
        padding: '8px 16px',
        textDecoration: 'none',
      }}
    >
      Merchant Center
    </a>
  )
}
