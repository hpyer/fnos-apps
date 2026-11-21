export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'AppError'; this.status = status; }
}
export function fail(message, status = 400) { throw new AppError(message, status); }
