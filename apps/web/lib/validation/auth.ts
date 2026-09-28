import { z } from 'zod';

// Deliberately duplicated from services/api/src/modules/auth/schema.ts, not
// imported from a shared package. There's no packages/shared yet (Section
// 53 anticipates one), and standing up cross-workspace TypeScript project
// references for two small schemas would be more plumbing than the
// duplication it removes — a real refactor to make once more than one
// shape needs sharing, not a default to reach for on the first frontend
// form (Section 2: don't over-engineer a simple feature).
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export type LoginFormValues = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(8, 'Must be at least 8 characters').max(128),
  name: z.string().trim().min(1, 'Name is required').max(100),
});

export type RegisterFormValues = z.infer<typeof registerSchema>;
