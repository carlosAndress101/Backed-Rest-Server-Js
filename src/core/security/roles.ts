// ADR-007: a code-level enum; roles are never looked up in the Role collection.
export const ROLES = ['ADMIN_ROLE', 'USER_ROLE', 'VENTAS_ROLE'] as const;
export type Role = (typeof ROLES)[number];
export const DEFAULT_ROLE: Role = 'USER_ROLE';
export const isRole = (v: unknown): v is Role =>
  typeof v === 'string' && (ROLES as readonly string[]).includes(v);

// AM-M6-5: the single source for "who manages the catalog" (ADR-040). The product/category route policies and
// ProductsService's ownership bypass all read this; no service re-types the list.
export const CATALOG_ROLES: readonly Role[] = ['ADMIN_ROLE', 'VENTAS_ROLE'];
