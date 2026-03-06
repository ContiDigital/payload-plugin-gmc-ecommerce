import type { Config } from 'payload'

import type { NormalizedPluginOptions } from '../types/index.js'

import { PLUGIN_SLUG } from '../constants.js'

export const applyAdminEnhancements = (
  config: Config,
  options: NormalizedPluginOptions,
): Config => {
  if (!config.admin) {
    config.admin = {}
  }

  if (!config.admin.components) {
    config.admin.components = {}
  }

  const mode = options.admin.mode

  // --- Sidebar navigation link ---
  if (mode === 'route' || mode === 'both') {
    if (!config.admin.components.beforeNavLinks) {
      config.admin.components.beforeNavLinks = []
    }

    ;(config.admin.components.beforeNavLinks as unknown[]).push(
      `${PLUGIN_SLUG}/client#MerchantCenterNavLink`,
    )
  }

  // --- Custom admin view (route) ---
  if (mode === 'route' || mode === 'both') {
    if (!config.admin.components.views) {
      config.admin.components.views = {}
    }

    const views = config.admin.components.views as Record<string, unknown>
    views.merchantCenter = {
      Component: `${PLUGIN_SLUG}/rsc#MerchantCenterAdminView`,
      path: options.admin.route,
    }
  }

  // --- Dashboard widget ---
  if (mode === 'dashboard' || mode === 'both') {
    if (!config.admin.components.beforeDashboard) {
      config.admin.components.beforeDashboard = []
    }

    ;(config.admin.components.beforeDashboard as unknown[]).push(
      `${PLUGIN_SLUG}/rsc#MerchantCenterDashboardWidget`,
    )
  }

  return config
}
