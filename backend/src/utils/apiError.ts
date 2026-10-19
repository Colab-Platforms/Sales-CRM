export class ApiError extends Error {
  statusCode: number;
  /** Optional machine-readable details a client can act on (never secrets); sent as the response `data`. */
  data?: unknown;

  constructor(message: string, statusCode: number, data?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.data = data;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}
