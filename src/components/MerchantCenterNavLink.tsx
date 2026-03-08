'use client'

import React from 'react'

type MerchantCenterNavLinkProps = {
  href?: string
  label?: string
}

export const MerchantCenterNavLink: React.FC<MerchantCenterNavLinkProps> = ({
  href = '/merchant-center',
  label = 'Merchant Center',
}) => {
  return (
    <a
      href={href}
      style={{
        color: 'inherit',
        display: 'block',
        fontSize: '0.95rem',
        padding: '0.35rem 0',
        textDecoration: 'none',
      }}
    >
      {label}
    </a>
  )
}
