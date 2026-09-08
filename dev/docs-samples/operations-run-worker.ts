/** docs/v2-operations.md — "Running the worker". */
import type { Config, Payload } from 'payload'

// Long-lived host: declare it in the Payload config.
export const jobs: Config['jobs'] = {
  tasks: [], // The plugin appends its task; required by Payload 3.37.
  autoRun: [{ cron: '* * * * *', limit: 25, queue: 'gmc' }],
}

// Anywhere else — serverless included — call this from your own scheduler.
export const runQueue = async (payload: Payload): Promise<void> => {
  await payload.jobs.run({ limit: 25, queue: 'gmc', sequential: true })
}
