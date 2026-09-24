import { z } from 'zod';

// The shapes the legacy express-validator chains checked. Whether the credentials are right is the service's
// question, answered with the generic 401 (C5), never validation's.
export const loginBody = z.object({
  // §10.3/§10.5: normalized exactly as sign-up normalizes it (trimmed, checked, then lowercased), so login is
  // case-insensitive on the email. A non-ASCII look-alike fails the check before it could be lowercased.
  email: z
    .string()
    .trim()
    .max(254)
    .pipe(z.email())
    .transform((value) => value.toLowerCase()),
  password: z.string().min(1),
});

export const googleBody = z.object({
  id_token: z.string().min(1),
});

export type LoginDto = z.infer<typeof loginBody>;
export type GoogleDto = z.infer<typeof googleBody>;
