import { expect, test } from '@playwright/test'

test('admin dashboard loads and shows Merchant Center widget', async ({ page }) => {
  await page.goto('/admin')

  // Login
  await page.fill('#field-email', 'dev@payloadcms.com')
  await page.fill('#field-password', 'test')
  await page.click('.form-submit button')

  // Dashboard should load
  await expect(page).toHaveTitle(/Dashboard/)

  // Merchant Center nav link should be visible
  await expect(page.getByText('Merchant Center')).toBeVisible()
})

test('merchant center admin view loads', async ({ page }) => {
  await page.goto('/admin')

  // Login
  await page.fill('#field-email', 'dev@payloadcms.com')
  await page.fill('#field-password', 'test')
  await page.click('.form-submit button')

  // Navigate to Merchant Center
  await page.getByText('Merchant Center').first().click()

  // Should show the Merchant Center heading
  await expect(page.getByRole('heading', { name: 'Merchant Center' })).toBeVisible()

  // Should show Connection Status section
  await expect(page.getByText('Connection Status')).toBeVisible()
})
