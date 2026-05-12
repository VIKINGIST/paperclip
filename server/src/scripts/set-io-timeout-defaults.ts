/**
 * ELE-195: Apply ioTimeoutSec defaults to Reviewer-Architecture, Implementer-1, Implementer-Architecture
 * Run: DATABASE_URL=... tsx src/scripts/set-io-timeout-defaults.ts
 */
import { createDb, agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://paperclip:paperclip@localhost:5432/paperclip";
const db = createDb(DATABASE_URL);

const AGENT_IO_TIMEOUTS: Array<{ id: string; name: string; ioTimeoutSec: number }> = [
  { id: "6a475e33-f209-4e6e-9ebd-fd3e2004ab9b", name: "Reviewer-Architecture", ioTimeoutSec: 600 },
  { id: "507f50bf-f812-42ee-89ad-7890ed402681", name: "Implementer-1",         ioTimeoutSec: 900 },
  { id: "47d6ade1-be05-4f45-a586-fb0214af5c99", name: "Implementer-Architecture", ioTimeoutSec: 1200 },
];

for (const { id, name, ioTimeoutSec } of AGENT_IO_TIMEOUTS) {
  const [agent] = await db.select({ id: agents.id, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);

  if (!agent) {
    console.warn(`[SKIP] ${name} (${id}) not found in DB`);
    continue;
  }
  const existing = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  if (existing.ioTimeoutSec === ioTimeoutSec) {
    console.log(`[OK]   ${name}: ioTimeoutSec already ${ioTimeoutSec}s`);
    continue;
  }
  const merged = { ...existing, ioTimeoutSec };
  await db.update(agents).set({ adapterConfig: merged }).where(eq(agents.id, id));
  console.log(`[SET]  ${name}: ioTimeoutSec=${ioTimeoutSec}s (was ${existing.ioTimeoutSec ?? "unset"})`);
}

console.log("Done.");
process.exit(0);
