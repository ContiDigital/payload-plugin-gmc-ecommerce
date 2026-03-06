import React from 'react'

export const MerchantCenterDashboardWidget: React.FC = () => {
  return (
    <div
      style={{
        backgroundColor: 'var(--theme-elevation-50)',
        border: '1px solid var(--theme-elevation-150)',
        borderRadius: '8px',
        marginBottom: '20px',
        padding: '20px',
      }}
    >
      <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px', marginTop: 0 }}>
        Google Merchant Center
      </h3>
      <p style={{ color: 'var(--theme-elevation-500)', fontSize: '13px', marginBottom: '12px' }}>
        Manage your product listings on Google Merchant Center.
      </p>
      <a
        href="merchant-center"
        style={{
          backgroundColor: '#2563eb',
          borderRadius: '4px',
          color: '#fff',
          display: 'inline-block',
          fontSize: '13px',
          padding: '6px 14px',
          textDecoration: 'none',
        }}
      >
        Open Merchant Center
      </a>
    </div>
  )
}
