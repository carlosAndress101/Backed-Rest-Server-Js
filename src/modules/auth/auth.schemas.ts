import { z } from 'zod';

// The shapes the legacy express-validator chains checked. Whether the credentials are right is the service's
// question, answered with the generic 401 (C5), never validation's.
export const loginBody = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const googleBody = z.object({
  id_token: z.string().min(1),
});

export type LoginDto = z.infer<typeof loginBody>;
export type GoogleDto = z.infer<typeof googleBody>;
