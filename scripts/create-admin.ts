/**
 * Create (or reset) a panel user with a random temporary password.
 *
 * The password is never printed: it is written to a file readable only by the owner (default
 * out/panel_password.txt, mode 600). The user must change it at the first login.
 *
 *   npx tsx scripts/create-admin.ts --email you@example.com --name You [--role staff] [--out f]
 */
import { closeSync, fchmodSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { hashPassword } from "../src/accounts/passwords.js";
import { getSettings } from "../src/config.js";
import { connect } from "../src/db/client.js";
import { adminUsers } from "../src/db/schema.js";
import { tokenUrlsafe } from "../src/panel/security.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      role: { type: "string", default: "admin" },
      out: { type: "string", default: "out/panel_password.txt" },
    },
  });
  if (!values.email || !values.name || !["admin", "staff"].includes(values.role)) {
    console.error("usage: create-admin.ts --email E --name N [--role admin|staff] [--out FILE]");
    process.exit(2);
  }
  const role = values.role;
  const email = values.email.trim().toLowerCase();
  const password = tokenUrlsafe(12);
  const passwordHash = await hashPassword(password);
  const database = connect(getSettings().databaseUrl);
  try {
    await database.db
      .insert(adminUsers)
      .values({
        email,
        name: values.name,
        role,
        passwordHash,
        isActive: true,
        mustChangePassword: true,
      })
      .onConflictDoUpdate({
        target: adminUsers.email,
        set: { passwordHash, role, isActive: true, mustChangePassword: true },
      });
  } finally {
    await database.close();
  }

  const out = values.out;
  mkdirSync(path.dirname(out), { recursive: true });
  const fd = openSync(out, "w", 0o600);
  try {
    fchmodSync(fd, 0o600); // an existing file keeps its old mode on open
    writeSync(fd, `${email}\n${password}\n`);
  } finally {
    closeSync(fd);
  }
  console.log(`${role} ${email} ready; temporary password written to ${out} (mode 600)`);
}

await main();
