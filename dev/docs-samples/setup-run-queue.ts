/** docs/v2-setup.md — "3. Run the queue and publish". */
import type { Payload } from 'payload'

// A long-lived host: jobs.autoRun, as in the config above. Anywhere else,
// including serverless, call this from your own scheduler. On SQLite, pass
// sequential: true — see below.
export const drainQueue = async (payload: Payload): Promise<void> => {
  await payload.jobs.run({ limit: 25, queue: 'gmc', sequential: true })
}
