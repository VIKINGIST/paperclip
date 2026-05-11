import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
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

const mockTerminateLocalService = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/local-service-supervisor.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/local-service-supervisor.ts")>(
    "../services/local-service-supervisor.ts",
  );
  return { ...actual, terminateLocalService: mockTerminateLocalService };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping io-timeout watchdog tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("subprocess io-timeout watchdog", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-io-timeout-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    mockTerminateLocalService.mockClear();
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRunningRun(opts: {
    now: Date;
    lastOutputAgeMs: number;
    ioTimeoutSec?: number;
    issueStatus?: string;
    skipIssue?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const lastOutputAt = new Date(opts.now.getTime() - opts.lastOutputAgeMs);

    await db.insert(companies).values({
      id: companyId,
      name: "IO Timeout Co",
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
      adapterConfig: opts.ioTimeoutSec != null ? { ioTimeoutSec: opts.ioTimeoutSec } : {},
      runtimeConfig: {},
      permissions: {},
    });
    if (!opts.skipIssue) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Long running task",
        status: opts.issueStatus ?? "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        updatedAt: lastOutputAt,
        createdAt: lastOutputAt,
      });
    }
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: lastOutputAt,
      processStartedAt: lastOutputAt,
      lastOutputAt,
      lastOutputSeq: 5,
      lastOutputStream: "stdout",
      contextSnapshot: opts.skipIssue ? {} : { issueId },
      logBytes: 0,
    });

    return { companyId, agentId, issueId, runId };
  }

  it("kills run and blocks issue after stdout silence exceeds ioTimeoutSec", async () => {
    const now = new Date("2026-05-11T10:00:00.000Z");
    const { companyId, issueId, runId } = await seedRunningRun({
      now,
      lastOutputAgeMs: 700_000, // ~11.7 min — exceeds 600s threshold
      ioTimeoutSec: 600,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanIoTimeoutRuns({ now, companyId });

    expect(result.killed).toBe(1);
    expect(result.skipped).toBe(0);

    // Run must be marked failed with io_timeout error code
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("io_timeout");
    expect(run?.error).toMatch(/700s/);

    // Source issue must be blocked with no assignee
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("blocked");
    expect(issue?.assigneeAgentId).toBeNull();

    // Audit comment must be posted on the issue
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Subprocess I/O Timeout");
    expect(comments[0]?.body).toContain("700s");
    expect(comments[0]?.body).toContain("600s");

    // Lifecycle run event must be appended
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(events.some((e) => e.message?.includes("io_timeout"))).toBe(true);
  });

  it("skips run when source issue status is cancelled (ELE-110 pre-emptive fix)", async () => {
    const now = new Date("2026-05-11T10:00:00.000Z");
    const { companyId, runId } = await seedRunningRun({
      now,
      lastOutputAgeMs: 700_000,
      ioTimeoutSec: 600,
      issueStatus: "cancelled",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanIoTimeoutRuns({ now, companyId });

    expect(result.killed).toBe(0);
    expect(result.skipped).toBe(1);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running"); // not killed
  });

  it("skips run when source issue status is done", async () => {
    const now = new Date("2026-05-11T10:00:00.000Z");
    const { companyId, runId } = await seedRunningRun({
      now,
      lastOutputAgeMs: 700_000,
      ioTimeoutSec: 600,
      issueStatus: "done",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanIoTimeoutRuns({ now, companyId });

    expect(result.killed).toBe(0);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
  });

  it("skips agent without ioTimeoutSec (opt-in safety)", async () => {
    const now = new Date("2026-05-11T10:00:00.000Z");
    const { companyId, runId } = await seedRunningRun({
      now,
      lastOutputAgeMs: 700_000,
      // ioTimeoutSec not set → opt-out
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanIoTimeoutRuns({ now, companyId });

    expect(result.killed).toBe(0);
    expect(result.skipped).toBe(1);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
  });

  it("skips run whose silence is below the threshold", async () => {
    const now = new Date("2026-05-11T10:00:00.000Z");
    const { companyId, runId } = await seedRunningRun({
      now,
      lastOutputAgeMs: 300_000, // 5 min — below 600s threshold
      ioTimeoutSec: 600,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanIoTimeoutRuns({ now, companyId });

    expect(result.killed).toBe(0);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
  });

  it("is idempotent: second call with already-failed run produces no kills", async () => {
    const now = new Date("2026-05-11T10:00:00.000Z");
    const { companyId } = await seedRunningRun({
      now,
      lastOutputAgeMs: 700_000,
      ioTimeoutSec: 600,
    });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.scanIoTimeoutRuns({ now, companyId });
    const second = await heartbeat.scanIoTimeoutRuns({ now, companyId });

    expect(first.killed).toBe(1);
    expect(second.killed).toBe(0); // run is already failed, not running
  });
});
