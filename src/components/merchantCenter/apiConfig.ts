import { asClientRecord, getClientString } from './recordUtils.js'

export type MerchantCenterApiConfig = {
  adminRoute: string
  apiRoute: string
  gmcAdminRoute: string
  gmcBasePath: string
  gmcEndpointBase: string
}

type AdminConfigLike = {
  custom?: Record<string, unknown>
  routes?: { admin?: string; api?: string }
}

export const resolveMerchantCenterApiConfig = (
  config: AdminConfigLike | undefined,
): MerchantCenterApiConfig => {
  const custom = asClientRecord(config?.custom)
  const apiRoute = getClientString(config?.routes?.api, '/api')
  const adminRoute = getClientString(config?.routes?.admin, '/admin')
  const gmcAdminRoute = getClientString(custom?.gmcAdminRoute, '/merchant-center')
  const gmcBasePath = getClientString(custom?.gmcApiBasePath, '/gmc')

  return {
    adminRoute,
    apiRoute,
    gmcAdminRoute,
    gmcBasePath,
    gmcEndpointBase: `${apiRoute}${gmcBasePath}`,
  }
}
