/** docs/v2-async-adapter.md — "Running commands": classifying a failure. */
import { classifyGmcCommandError } from 'payload-plugin-gmc-ecommerce'

export const classify = (
  error: unknown,
): { code?: string; message: string; retryable: boolean } => {
  const { code, message, retryable } = classifyGmcCommandError(error)
  return { code, message, retryable }
}
