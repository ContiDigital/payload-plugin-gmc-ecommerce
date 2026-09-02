/** HTTP-safe validation failure shared by the legacy and v2 request parsers. */
export class ValidationError extends Error {
  public readonly statusCode = 400

  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}
