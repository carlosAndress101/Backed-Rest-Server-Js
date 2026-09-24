import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

import { ValidationError, type ValidationIssue } from '../core/errors';

type Part = 'body' | 'query' | 'params';

/** Validates one request part; on failure throws ValidationError → 422 with details. Replaces express-validator. */
export const validate =
  (part: Part, schema: ZodType): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      const details: ValidationIssue[] = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      throw new ValidationError(details);
    }
    if (part === 'body') req.body = result.data;
    else Object.defineProperty(req, part, { value: result.data, configurable: true }); // Express 5: query/params are getters
    next();
  };
