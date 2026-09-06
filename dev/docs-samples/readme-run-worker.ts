/** README.md — "Running the worker". */
import type { Payload } from 'payload'

export const runQueue = async (payload: Payload): Promise<void> => {
  await payload.jobs.run({ limit: 25, queue: 'gmc', sequential: true })
}
