import type { AdminViewServerProps } from 'payload'
import type React from 'react'

import { DefaultTemplate } from '@payloadcms/next/templates'
import { Gutter } from '@payloadcms/ui'

import { MerchantCenterDashboardClient } from './MerchantCenterDashboardClient.js'

type MerchantCenterAdminViewProps = {
  title?: string
} & AdminViewServerProps

export const MerchantCenterAdminView: React.FC<MerchantCenterAdminViewProps> = ({
  initPageResult,
  params,
  searchParams,
  title = 'Merchant Center',
}) => {
  return (
    <DefaultTemplate
      i18n={initPageResult.req.i18n}
      locale={initPageResult.locale}
      params={params}
      payload={initPageResult.req.payload}
      permissions={initPageResult.permissions}
      searchParams={searchParams}
      user={initPageResult.req.user || undefined}
      visibleEntities={initPageResult.visibleEntities}
    >
      <Gutter>
        <MerchantCenterDashboardClient title={title} />
      </Gutter>
    </DefaultTemplate>
  )
}
