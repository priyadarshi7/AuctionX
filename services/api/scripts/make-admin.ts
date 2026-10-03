// Promotes (or demotes) a user to/from ADMIN. This is the ONLY way an admin
// account comes into existence: there is deliberately no signup flag, env
// allowlist or API endpoint for it, so the API has no admin-creating surface
// to attack — you need shell access to the deployment to run this
// (ADR-0039). Run standalone, so .env is loaded here, not by the server.
//
//   npm run make-admin -- someone@example.com
//   npm run make-admin -- someone@example.com --demote
import 'dotenv/config';
import { prisma } from '../src/infrastructure/database/prisma';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const demote = args.includes('--demote');
  const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase();
  if (!email) {
    throw new Error('Usage: npm run make-admin -- <email> [--demote]');
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(`No user with email "${email}". They must register first.`);
  }
  const role = demote ? 'USER' : 'ADMIN';
  if (user.role === role) {
    console.log(`${email} is already ${role}. Nothing changed.`);
    return;
  }

  // Role change and its audit entry commit together. actorId is null: this
  // happens outside the API, recorded as via=cli.
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { role } });
    await tx.adminAuditLog.create({
      data: {
        actorId: null,
        action: 'user.role_changed',
        targetType: 'user',
        targetId: user.id,
        metadata: { from: user.role, to: role, via: 'cli' },
      },
    });
  });
  console.log(`${email} is now ${role}. They must log in again for it to take effect.`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
