import { describe, expect, test } from 'vitest'

import { resolveMerchantCenterApiConfig } from '../apiConfig.js'

describe('resolveMerchantCenterApiConfig', () => {
  test('uses default admin API routes when config is missing', () => {
    expect(resolveMerchantCenterApiConfig(undefined)).toEqual({
      adminRoute: '/admin',
      apiRoute: '/api',
      gmcAdminRoute: '/merchant-center',
      gmcBasePath: '/gmc',
      gmcEndpointBase: '/api/gmc',
    })
  })

  test('respects custom admin API and GMC base paths', () => {
    expect(resolveMerchantCenterApiConfig({
      custom: {
        gmcAdminRoute: '/merchant-center-dashboard',
        gmcApiBasePath: '/merchant-sync',
      },
      routes: { admin: '/cms-admin', api: '/cms-api' },
    })).toEqual({
      adminRoute: '/cms-admin',
      apiRoute: '/cms-api',
      gmcAdminRoute: '/merchant-center-dashboard',
      gmcBasePath: '/merchant-sync',
      gmcEndpointBase: '/cms-api/merchant-sync',
    })
  })
})
