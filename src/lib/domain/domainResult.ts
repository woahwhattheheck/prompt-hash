/**
 * Shared HTTP-shaped result for domain operations (#184).
 *
 * Both the Vercel serverless adapters (`api/`) and the Express controllers
 * (`server/src/controllers`) return this shape so status codes and error
 * bodies stay identical across deployment adapters.
 */

export type DomainResult<T = unknown> = {
  status: number;
  body: T;
};

export function ok<T>(body: T, status = 200): DomainResult<T> {
  return { status, body };
}

export function created<T>(body: T): DomainResult<T> {
  return { status: 201, body };
}

export function fail(status: number, error: string): DomainResult<{ error: string }> {
  return { status, body: { error } };
}

/** Write a DomainResult onto a Vercel / Express-like response. */
export function sendDomainResult(
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  result: DomainResult,
): unknown {
  return res.status(result.status).json(result.body);
}
