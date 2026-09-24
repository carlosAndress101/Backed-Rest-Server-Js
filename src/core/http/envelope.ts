import type { AppError, ErrorCode, ValidationIssue } from '../errors';

export interface DataEnvelope<T> {
  data: T;
}
export interface PageMeta {
  total: number;
  limit: number;
  offset: number;
}
export interface PageEnvelope<T> {
  data: T[];
  meta: PageMeta;
}
export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; details?: readonly ValidationIssue[] };
}

export const envelope = <T>(data: T): DataEnvelope<T> => ({ data });
export const pageEnvelope = <T>(data: T[], meta: PageMeta): PageEnvelope<T> => ({ data, meta });
export const errorEnvelope = (err: AppError): ErrorEnvelope => ({
  error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) },
});
