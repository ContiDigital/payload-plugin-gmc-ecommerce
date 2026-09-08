/** HTTP-safe validation failure thrown by the v2 request parsers. */
export class ValidationError extends Error {
  public readonly statusCode = 400

  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}
