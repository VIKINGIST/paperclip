import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: vi.fn() })),
  };
});

vi.mock("../services/local-service-supervisor.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/local-service-supervisor.ts")>(
    "../services/local-service-supervisor.ts",
  );
  return { ...actual, terminateLocalService: vi.fn(async () => {}) };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping retry-budget tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("per-source-issue retry budget", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-retry-budget-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedScenario(opts: {
    priorFailCount: number;
    priorFailAgeMs: number; // how old each prior fail's finishedAt is
    adapterConfig?: Record<string, unknown>;
  }) {
    const now = new Date("2026-05-12T10:00:00.000Z");
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Retry Budget Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementer",
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: opts.adapterConfig ?? {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Flaky task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      updatedAt: now,
      createdAt: now,
    });

    // Seed prior failed runs
    const priorFailedAt = new Date(now.getTime() - opts.priorFailAgeMs);
    for (let i = 0; i < opts.priorFailCount; i++) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: "failed",
        invocationSource: "assignment",
        triggerDetail: "system",
        contextSnapshot: { issueId },
        finishedAt: priorFailedAt,
        logBytes: 0,
        lastOutputSeq: 0,
      });
    }

    // Seed the current failed run that wants to retry
    const currentRunId = randomUUID();
    const currentFailedAt = new Date(now.getTime() - 5_000); // 5 seconds ago
    await db.insert(heartbeatRuns).values({
      id: currentRunId,
      companyId,
      agentId,
      status: "failed",
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId },
      finishedAt: currentFailedAt,
      logBytes: 0,
      lastOutputSeq: 0,
      // Add transient error so scheduleBoundedRetry normally proceeds
      errorCode: "claude_transient_upstream",
    });

    return { now, companyId, agentId, issueId, currentRunId };
  }

  it("auto-blocks issue and skips spawn when retry budget is exceeded (3 recent fails)", async () => {
    const { currentRunId, issueId, now } = await seedScenario({
      priorFailCount: 3, // already at limit; current run would be the 4th attempt
      priorFailAgeMs: 10 * 60 * 1000, // 10 min ago — within 30-min window
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scheduleBoundedRetry(currentRunId, { now });

    expect(result.outcome).toBe("retry_budget_exceeded");

    // Issue must be blocked with no assignee
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("blocked");
    expect(issue?.assigneeAgentId).toBeNull();

    // Audit comment must be posted
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Auto-Blocked: Retry Budget Exceeded");
    expect(comments[0]?.body).toContain("3 failed runs");
    expect(comments[0]?.body).toContain("30 minutes");

    // No new heartbeat run was queued for this issue
    const newRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          eq(heartbeatRuns.status, "queued"),
        ),
      );
    expect(newRuns).toHaveLength(0);
  });

  it("allows retry when prior fail count is below threshold (2 recent fails)", async () => {
    const { currentRunId, issueId, now } = await seedScenario({
      priorFailCount: 2, // 2 prior + current = 3 total, but budget counts prior closed runs
      priorFailAgeMs: 10 * 60 * 1000,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scheduleBoundedRetry(currentRunId, { now });

    // Should NOT be budget exceeded
    expect(result.outcome).not.toBe("retry_budget_exceeded");

    // Issue must NOT be blocked
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).not.toBe("blocked");
  });

  it("allows retry when all prior fails are outside the 30-minute window", async () => {
    const { currentRunId, issueId, now } = await seedScenario({
      priorFailCount: 5, // many fails, but old
      priorFailAgeMs: 35 * 60 * 1000, // 35 min ago — outside 30-min window
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scheduleBoundedRetry(currentRunId, { now });

    expect(result.outcome).not.toBe("retry_budget_exceeded");

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).not.toBe("blocked");
  });

  it("respects per-agent retryBudgetOptOut: true — never blocks regardless of fails", async () => {
    const { currentRunId, issueId, now } = await seedScenario({
      priorFailCount: 10, // way over limit
      priorFailAgeMs: 5 * 60 * 1000, // 5 min ago — in window
      adapterConfig: { retryBudgetOptOut: true },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scheduleBoundedRetry(currentRunId, { now });

    expect(result.outcome).not.toBe("retry_budget_exceeded");

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).not.toBe("blocked");
  });

  it("respects per-agent retryBudgetMaxFails override — blocks at custom threshold", async () => {
    const { currentRunId, issueId, now } = await seedScenario({
      priorFailCount: 5, // above custom limit of 5
      priorFailAgeMs: 5 * 60 * 1000,
      adapterConfig: { retryBudgetMaxFails: 5 },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scheduleBoundedRetry(currentRunId, { now });

    expect(result.outcome).toBe("retry_budget_exceeded");

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("blocked");
  });
});
