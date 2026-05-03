import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: vi.fn() })) };
});

vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => null }));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent error-recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const FIXTURE_NOW = new Date("2026-05-03T10:00:00.000Z");
// Error entered 5 minutes ago — past the 2-min default threshold.
const ERROR_HEARTBEAT_AT = new Date(FIXTURE_NOW.getTime() - 5 * 60 * 1000);
// Error entered 30 seconds ago — not yet past threshold.
const FRESH_ERROR_HEARTBEAT_AT = new Date(FIXTURE_NOW.getTime() - 30 * 1000);

describeEmbeddedPostgres("heartbeat agent error-state auto-recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-error-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedErrorAgent(opts?: {
    lastHeartbeatAt?: Date;
    metadata?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementer-Test",
      role: "engineer",
      status: "error",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      lastHeartbeatAt: opts?.lastHeartbeatAt ?? ERROR_HEARTBEAT_AT,
      metadata: opts?.metadata ?? {},
    });

    return { companyId, agentId };
  }

  it("recovers an agent stuck in error state after minAgeMs elapsed", async () => {
    const { agentId } = await seedErrorAgent();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileErrorStateAgents({ now: FIXTURE_NOW });

    expect(result.candidates).toBe(1);
    expect(result.recovered).toBe(1);
    expect(result.quarantined).toBe(0);
    expect(result.skipped).toBe(0);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("idle");
    expect((agent.metadata as Record<string, unknown>).autoRecoveryCount).toBe(1);
  });

  it("does NOT recover an agent whose error is fresher than minAgeMs", async () => {
    const { agentId } = await seedErrorAgent({ lastHeartbeatAt: FRESH_ERROR_HEARTBEAT_AT });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileErrorStateAgents({ now: FIXTURE_NOW });

    expect(result.candidates).toBe(0);
    expect(result.recovered).toBe(0);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("error");
  });

  it("increments autoRecoveryCount across multiple recoveries within the flap window", async () => {
    const { agentId } = await seedErrorAgent({
      metadata: { autoRecoveryCount: 1, autoRecoveryWindowStart: new Date(FIXTURE_NOW.getTime() - 10 * 60 * 1000).toISOString() },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileErrorStateAgents({ now: FIXTURE_NOW });

    expect(result.recovered).toBe(1);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect((agent.metadata as Record<string, unknown>).autoRecoveryCount).toBe(2);
  });

  it("quarantines an agent that has reached the flap threshold", async () => {
    const { agentId } = await seedErrorAgent({
      metadata: {
        autoRecoveryCount: 3,
        autoRecoveryWindowStart: new Date(FIXTURE_NOW.getTime() - 10 * 60 * 1000).toISOString(),
      },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileErrorStateAgents({ now: FIXTURE_NOW, flapThreshold: 3 });

    expect(result.quarantined).toBe(1);
    expect(result.recovered).toBe(0);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("error");
    expect(typeof (agent.metadata as Record<string, unknown>).autoRecoveryQuarantinedAt).toBe("string");
  });

  it("resets flap counter and recovers when the flap window has expired", async () => {
    const expiredWindowStart = new Date(FIXTURE_NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const { agentId } = await seedErrorAgent({
      metadata: { autoRecoveryCount: 3, autoRecoveryWindowStart: expiredWindowStart },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileErrorStateAgents({ now: FIXTURE_NOW, flapThreshold: 3, flapWindowMs: 60 * 60 * 1000 });

    expect(result.recovered).toBe(1);
    expect(result.quarantined).toBe(0);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("idle");
    expect((agent.metadata as Record<string, unknown>).autoRecoveryCount).toBe(1);
  });

  it("skips agents already quarantined", async () => {
    const { agentId } = await seedErrorAgent({
      metadata: { autoRecoveryQuarantinedAt: new Date(FIXTURE_NOW.getTime() - 60 * 1000).toISOString() },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileErrorStateAgents({ now: FIXTURE_NOW });

    expect(result.skipped).toBe(1);
    expect(result.recovered).toBe(0);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("error");
  });

  it("does not recover agents in paused or idle state", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Co2", issuePrefix: "CO2", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: randomUUID(), companyId, name: "A-paused", role: "engineer", status: "paused", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {}, lastHeartbeatAt: ERROR_HEARTBEAT_AT },
      { id: randomUUID(), companyId, name: "A-idle", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {}, lastHeartbeatAt: ERROR_HEARTBEAT_AT },
    ]);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileErrorStateAgents({ now: FIXTURE_NOW });

    expect(result.candidates).toBe(0);
    expect(result.recovered).toBe(0);
  });
});
