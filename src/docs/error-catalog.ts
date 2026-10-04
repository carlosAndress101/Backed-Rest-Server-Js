import type { ErrorCode } from '../core/errors';

export interface ErrorCatalogEntry {
  readonly status: number;
  readonly summary: string;
}

/**
 * Every ErrorCode, in app-error.ts order, with the status its error class answers. `satisfies` makes a missing or an
 * extra code a compile error; a test pins each status to the real class.
 */
export const ERROR_CATALOG = {
  BAD_REQUEST: {
    status: 400,
    summary: 'The request is malformed or unsupported, for example malformed JSON or a bad URL escape',
  },
  UNAUTHORIZED: {
    status: 401,
    summary:
      'Not authenticated: the token is missing, invalid, expired or revoked, or the credentials are wrong',
  },
  FORBIDDEN: { status: 403, summary: 'The caller is signed in but may not perform this action' },
  NOT_FOUND: { status: 404, summary: 'The route or the resource does not exist, or is inactive' },
  CONFLICT: { status: 409, summary: 'The resource already exists, for example a duplicate email or name' },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    summary: 'The body is over its size limit: 100 kB of JSON or a 5 MB upload',
  },
  VALIDATION_FAILED: { status: 422, summary: 'The input failed validation; `details` lists every issue' },
  RATE_LIMITED: { status: 429, summary: 'Too many requests; try again later' },
  INTERNAL: { status: 500, summary: 'An unexpected server error' },
} as const satisfies Record<ErrorCode, ErrorCatalogEntry>;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as [ErrorCode, ...ErrorCode[]];
