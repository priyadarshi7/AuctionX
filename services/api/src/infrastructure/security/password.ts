import * as argon2 from 'argon2';

// OWASP-recommended Argon2id baseline (as of the 2023+ Password Storage
// Cheat Sheet): 19 MiB memory, 2 iterations, 1 degree of parallelism.
// Memory-hardness is the point — it makes each guess expensive to
// parallelize on GPU/ASIC cracking hardware, unlike a plain fast hash.
const HASH_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plainPassword: string): Promise<string> {
  return argon2.hash(plainPassword, HASH_OPTIONS);
}

export function verifyPassword(hash: string, plainPassword: string): Promise<boolean> {
  return argon2.verify(hash, plainPassword);
}
