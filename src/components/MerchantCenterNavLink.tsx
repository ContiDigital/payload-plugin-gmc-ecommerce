'use client'

import { useConfig } from '@payloadcms/ui'
import React from 'react'

import { resolveMerchantCenterApiConfig } from './merchantCenter/apiConfig.js'

export const MerchantCenterNavLink: React.FC = () => {
  const { config } = useConfig()
  const { adminRoute, gmcAdminRoute } = resolveMerchantCenterApiConfig(config)

  return (
    <a
      href={`${adminRoute}${gmcAdminRoute}`}
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
