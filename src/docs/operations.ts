import { z } from 'zod';

import { googleBody, loginBody, passwordChangeBody } from '../modules/auth/auth.schemas';
import {
  categoryIdParams,
  createCategoryBody,
  paginationQuerySchema,
  updateCategoryBody,
} from '../modules/categories/category.schemas';
import { mediaParams } from '../modules/media/media.schemas';
import { MAX_FILE_BYTES } from '../modules/media/media.upload';
import { createProductBody, productIdParams, updateProductBody } from '../modules/products/product.schemas';
import { SEARCH_COLLECTIONS } from '../modules/search/search.service';
import { createUserBody, updateUserBody, userIdParams } from '../modules/users/user.schemas';
import type { ApiOperation } from './openapi';

// The static catalog of every live /api operation (Decision 1). Request schemas are the modules' own exports, by
// identity; operations.test.ts checks this list against the permission matrix (ADR-044) and every module DTO.

/** D4 (ADR-048): documentation only. The route validates nothing; the service answers 400 for an unknown collection. */
export const searchParams = z.object({ collection: z.enum(SEARCH_COLLECTIONS), term: z.string() });

/** Enforced by fileParser and requireImage (400/413), never by zod: so no 422. */
export const imageUpload = z.object({
  file: z
    .file()
    .max(MAX_FILE_BYTES)
    .describe('One PNG, JPEG or GIF, recognised by its first bytes; at most 5 MB'),
});

/** search.service.ts caps every search at 20 results (MAX_RESULTS, not exported: D4 leaves the module untouched). */
const SEARCH_MAX_RESULTS = 20;

const PASSWORD_RULE = 'A password is 8 characters to 72 UTF-8 bytes.';
const EMAIL_RULE = 'The email is trimmed, checked as an address and lowercased.';

export const API_OPERATIONS: readonly ApiOperation[] = [
  // Auth
  {
    operationId: 'login',
    method: 'post',
    path: '/api/auth/login',
    tag: 'Auth',
    summary: 'Log in with an email and a password',
    description: `Anyone. ${EMAIL_RULE} Wrong credentials and an inactive account are the same 401. Limited per IP and per account (429).`,
    security: 'none',
    body: { schema: loginBody, mediaType: 'application/json' },
    success: {
      status: 200,
      description: 'A session token and the user',
      body: { envelope: 'data', of: 'Session' },
    },
    errors: ['BAD_REQUEST', 'UNAUTHORIZED', 'PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED', 'RATE_LIMITED'],
  },
  {
    operationId: 'googleSignIn',
    method: 'post',
    path: '/api/auth/google',
    tag: 'Auth',
    summary: 'Sign in with a Google ID token',
    description:
      'Anyone. The Google address must be verified; a first sign-in creates the account. Shares the login rate limit (429).',
    security: 'none',
    body: { schema: googleBody, mediaType: 'application/json' },
    success: {
      status: 200,
      description: 'A session token and the user',
      body: { envelope: 'data', of: 'Session' },
    },
    errors: ['BAD_REQUEST', 'UNAUTHORIZED', 'PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED', 'RATE_LIMITED'],
  },
  {
    operationId: 'logoutAll',
    method: 'post',
    path: '/api/auth/logout-all',
    tag: 'Auth',
    summary: 'Revoke every session of the caller',
    description: 'Any signed-in user, for their own account. Every token issued so far stops working.',
    security: 'bearer',
    success: { status: 204, description: 'Every session is revoked' },
    errors: ['UNAUTHORIZED'],
  },
  {
    operationId: 'changePassword',
    method: 'put',
    path: '/api/auth/password',
    tag: 'Auth',
    summary: 'Change the caller’s password',
    description: `Any signed-in user, for their own account. A wrong current password is a 401. ${PASSWORD_RULE} Every earlier token is revoked.`,
    security: 'bearer',
    body: { schema: passwordChangeBody, mediaType: 'application/json' },
    success: {
      status: 200,
      description: 'A new session token',
      body: { envelope: 'data', of: 'TokenGrant' },
    },
    errors: ['BAD_REQUEST', 'UNAUTHORIZED', 'PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED'],
  },

  // Users
  {
    operationId: 'listUsers',
    method: 'get',
    path: '/api/user',
    tag: 'Users',
    summary: 'List active users',
    description: 'ADMIN_ROLE only.',
    security: 'bearer',
    query: paginationQuerySchema,
    success: { status: 200, description: 'A page of users', body: { envelope: 'page', of: 'User' } },
    errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  },
  {
    operationId: 'createUser',
    method: 'post',
    path: '/api/user',
    tag: 'Users',
    summary: 'Sign up',
    description: `Anyone. Every new account is USER_ROLE; a role in the body is ignored. ${EMAIL_RULE} ${PASSWORD_RULE}`,
    security: 'none',
    body: { schema: createUserBody, mediaType: 'application/json' },
    success: { status: 201, description: 'The new user', body: { envelope: 'data', of: 'User' } },
    errors: ['BAD_REQUEST', 'CONFLICT', 'PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED'],
  },
  {
    operationId: 'updateUser',
    method: 'put',
    path: '/api/user/{id}',
    tag: 'Users',
    summary: 'Update a user',
    description: `ADMIN_ROLE, or the account itself. Only an administrator may set role and state, and never on their own account (403). The body is optional. ${PASSWORD_RULE}`,
    security: 'bearer',
    params: userIdParams,
    body: { schema: updateUserBody, mediaType: 'application/json' },
    success: { status: 200, description: 'The updated user', body: { envelope: 'data', of: 'User' } },
    errors: [
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'PAYLOAD_TOO_LARGE',
      'VALIDATION_FAILED',
    ],
  },
  {
    operationId: 'deleteUser',
    method: 'delete',
    path: '/api/user/{id}',
    tag: 'Users',
    summary: 'Deactivate a user',
    description: 'ADMIN_ROLE only, and never their own account (403). A soft delete.',
    security: 'bearer',
    params: userIdParams,
    success: { status: 204, description: 'The user is deactivated' },
    errors: ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  },

  // Categories
  {
    operationId: 'listCategories',
    method: 'get',
    path: '/api/category',
    tag: 'Categories',
    summary: 'List active categories',
    description: 'Anyone.',
    security: 'none',
    query: paginationQuerySchema,
    success: { status: 200, description: 'A page of categories', body: { envelope: 'page', of: 'Category' } },
    errors: ['VALIDATION_FAILED'],
  },
  {
    operationId: 'getCategory',
    method: 'get',
    path: '/api/category/{id}',
    tag: 'Categories',
    summary: 'Get an active category',
    description: 'Anyone.',
    security: 'none',
    params: categoryIdParams,
    success: { status: 200, description: 'The category', body: { envelope: 'data', of: 'Category' } },
    errors: ['BAD_REQUEST', 'NOT_FOUND', 'VALIDATION_FAILED'],
  },
  {
    operationId: 'createCategory',
    method: 'post',
    path: '/api/category',
    tag: 'Categories',
    summary: 'Create a category',
    description:
      'Any signed-in user. The name is stored in upper case and must be unique among active categories.',
    security: 'bearer',
    body: { schema: createCategoryBody, mediaType: 'application/json' },
    success: { status: 201, description: 'The new category', body: { envelope: 'data', of: 'Category' } },
    errors: ['BAD_REQUEST', 'UNAUTHORIZED', 'CONFLICT', 'PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED'],
  },
  {
    operationId: 'updateCategory',
    method: 'put',
    path: '/api/category/{id}',
    tag: 'Categories',
    summary: 'Rename a category',
    description: 'ADMIN_ROLE or VENTAS_ROLE. Categories are shared: there are no creator rights (AM-M6-2).',
    security: 'bearer',
    params: categoryIdParams,
    body: { schema: updateCategoryBody, mediaType: 'application/json' },
    success: { status: 200, description: 'The updated category', body: { envelope: 'data', of: 'Category' } },
    errors: [
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'PAYLOAD_TOO_LARGE',
      'VALIDATION_FAILED',
    ],
  },
  {
    operationId: 'deleteCategory',
    method: 'delete',
    path: '/api/category/{id}',
    tag: 'Categories',
    summary: 'Deactivate a category',
    description: 'ADMIN_ROLE or VENTAS_ROLE. A soft delete; there are no creator rights (AM-M6-2).',
    security: 'bearer',
    params: categoryIdParams,
    success: { status: 204, description: 'The category is deactivated' },
    errors: ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  },

  // Products
  {
    operationId: 'listProducts',
    method: 'get',
    path: '/api/product',
    tag: 'Products',
    summary: 'List active products',
    description: 'Anyone. Each product carries its creator’s and its category’s name.',
    security: 'none',
    query: paginationQuerySchema,
    success: { status: 200, description: 'A page of products', body: { envelope: 'page', of: 'Product' } },
    errors: ['VALIDATION_FAILED'],
  },
  {
    operationId: 'getProduct',
    method: 'get',
    path: '/api/product/{id}',
    tag: 'Products',
    summary: 'Get an active product',
    description: 'Anyone. The product carries its creator’s and its category’s name.',
    security: 'none',
    params: productIdParams,
    success: { status: 200, description: 'The product', body: { envelope: 'data', of: 'Product' } },
    errors: ['BAD_REQUEST', 'NOT_FOUND', 'VALIDATION_FAILED'],
  },
  {
    operationId: 'createProduct',
    method: 'post',
    path: '/api/product',
    tag: 'Products',
    summary: 'Create a product',
    description:
      'Any signed-in user, who becomes its creator. The category must be active (404 otherwise); the name is stored in upper case and must be unique among active products.',
    security: 'bearer',
    body: { schema: createProductBody, mediaType: 'application/json' },
    success: { status: 201, description: 'The new product', body: { envelope: 'data', of: 'Product' } },
    errors: [
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'NOT_FOUND',
      'CONFLICT',
      'PAYLOAD_TOO_LARGE',
      'VALIDATION_FAILED',
    ],
  },
  {
    operationId: 'updateProduct',
    method: 'put',
    path: '/api/product/{id}',
    tag: 'Products',
    summary: 'Update a product',
    description:
      'ADMIN_ROLE, VENTAS_ROLE, or the product’s creator (ADR-041). A new category must be active. The creator never changes.',
    security: 'bearer',
    params: productIdParams,
    body: { schema: updateProductBody, mediaType: 'application/json' },
    success: { status: 200, description: 'The updated product', body: { envelope: 'data', of: 'Product' } },
    errors: [
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'PAYLOAD_TOO_LARGE',
      'VALIDATION_FAILED',
    ],
  },
  {
    operationId: 'deleteProduct',
    method: 'delete',
    path: '/api/product/{id}',
    tag: 'Products',
    summary: 'Deactivate a product',
    description: 'ADMIN_ROLE, VENTAS_ROLE, or the product’s creator (ADR-041). A soft delete.',
    security: 'bearer',
    params: productIdParams,
    success: { status: 204, description: 'The product is deactivated' },
    errors: ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  },

  // Search
  {
    operationId: 'search',
    method: 'get',
    path: '/api/search/{collection}/{term}',
    tag: 'Search',
    summary: 'Search a collection',
    description:
      'Anyone for categories and products; ADMIN_ROLE only for users, so a token is needed there. A case-insensitive match on the name (users: name or email; products: name or description); a term that is an ObjectId finds that one record. Active records only. An unknown collection is a 400.',
    security: 'optional',
    params: searchParams,
    success: {
      status: 200,
      description: 'The matching active records',
      body: { envelope: 'data-list', of: ['User', 'Category', 'Product'], maxItems: SEARCH_MAX_RESULTS },
    },
    errors: ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN'],
  },

  // Media
  {
    operationId: 'replaceImage',
    method: 'put',
    path: '/api/uploads/{collection}/{id}',
    tag: 'Media',
    summary: 'Replace a user’s or a product’s image',
    description:
      'A user image: ADMIN_ROLE or the account itself. A product image: ADMIN_ROLE or VENTAS_ROLE (a product’s creator has no media rights). The previous image is deleted.',
    security: 'bearer',
    params: mediaParams,
    body: { schema: imageUpload, mediaType: 'multipart/form-data' },
    success: {
      status: 200,
      description: 'The updated user or product',
      body: { envelope: 'data', of: ['User', 'Product'] },
    },
    errors: [
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'PAYLOAD_TOO_LARGE',
      'VALIDATION_FAILED',
    ],
  },
  {
    operationId: 'showImage',
    method: 'get',
    path: '/api/uploads/{collection}/{id}',
    tag: 'Media',
    summary: 'Redirect to a user’s or a product’s image',
    description: 'Anyone. Answers a 302 to the stored image URL; a record without an image is a 404.',
    security: 'none',
    params: mediaParams,
    success: { status: 302, description: 'Redirects to the image' },
    errors: ['BAD_REQUEST', 'NOT_FOUND', 'VALIDATION_FAILED'],
  },
];
