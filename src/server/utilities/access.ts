export class AccessDeniedError extends Error {
  public readonly statusCode = 403

  constructor(message = 'Access denied') {
    super(message)
    this.name = 'AccessDeniedError'
  }
}
