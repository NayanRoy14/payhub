import { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 + modern Node do not automatically catch a rejected promise
 * thrown inside an async route handler — it becomes an unhandled rejection,
 * and Node terminates the whole process by default (this is exactly how a
 * single malformed/out-of-order webhook once took down the entire server).
 * Wrapping every async handler with this forwards any thrown/rejected error
 * to Express's error-handling middleware (see server.ts) instead, so one
 * bad request can never crash requests in flight for everyone else.
 */
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // Promise.resolve(...) catches a rejected promise from an async handler;
      // the surrounding try/catch catches a handler that throws synchronously
      // before it ever returns a promise (e.g. a bug before its first `await`).
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (err) {
      next(err);
    }
  };
}
