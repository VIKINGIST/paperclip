import { randomUUID } from "node:crypto";
import { and, eq, or, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "ok",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres in-progress handoff tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Wall-clock reference shared across fixtures in each test.
const FIXTURE_NOW = new Date("2026-03-19T01:00:00.000Z");
// Heartbeat finished 14 min ago — comfortably past the 10 min default threshold.
const LAST_HEARTBEAT_AT = new Date(FIXTURE_NOW.getTime() - 14 * 60 * 1000);

describeEmbeddedPostgres("heartbeat in-progress handoff recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-inprogress-handoff-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    // Cancel any runs still in flight so FK constraints don't block the rest of cleanup.
    const activeRuns = await db
      .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
      .from(heartbeatRuns)
      .where(or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")));
    if (activeRuns.length > 0) {
      const now = new Date();
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled", finishedAt: now, updatedAt: now, errorCode: "test_cleanup" })
        .where(inArray(heartbeatRuns.id, activeRuns.map((r) => r.id)));
      const wakeIds = activeRuns.map((r) => r.wakeupRequestId).filter((id): id is string => typeof id === "string");
      if (wakeIds.length > 0) {
        await db
          .update(agentWakeupRequests)
          .set({ status: "cancelled", finishedAt: new Date() })
          .where(inArray(agentWakeupRequests.id, wakeIds));
      }
    }
    // Delete in FK-safe order.
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    for (let attempt = 0; attempt < 5; attempt++) {
      await db.delete(heartbeatRuns);
      try {
        await db.delete(agentRuntimeState);
        break;
      } catch {
        if (attempt === 4) throw new Error("Failed to clean agentRuntimeState after 5 attempts");
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(issues);
    for (let attempt = 0; attempt < 5; attempt++) {
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch {
        if (attempt === 4) throw new Error("Failed to clean agents after 5 attempts");
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function waitForRunToSettle(
    heartbeat: ReturnType<typeof heartbeatService>,
    runId: string,
    timeoutMs = 5_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (!run || (run.status !== "queued" && run.status !== "running")) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return heartbeat.getRun(runId);
  }

  // ---------------------------------------------------------------------------
  // Fixture helpers
  // ---------------------------------------------------------------------------

  async function seedHandoffFixture(opts?: {
    /** Override last heartbeat finished-at. Defaults to LAST_HEARTBEAT_AT (14 min before FIXTURE_NOW). */
    lastHeartbeatAt?: Date;
    /** Omit reviewer agent from the company. */
    noReviewer?: boolean;
    /** Role to use for the engineer agent (must be "engineer" for the trigger to fire). */
    engineerRole?: string;
    /** If set, stamp executionState.lastAutoHandoffAt with this value. */
    lastAutoHandoffAt?: Date;
  }) {
    const companyId = randomUUID();
    const engineerId = randomUUID();
    const reviewerId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeatAt = opts?.lastHeartbeatAt ?? LAST_HEARTBEAT_AT;

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: engineerId,
      companyId,
      name: "Paperclip-Implementer",
      role: opts?.engineerRole ?? "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    if (!opts?.noReviewer) {
      await db.insert(agents).values({
        id: reviewerId,
        companyId,
        name: "Reviewer-1",
        role: "reviewer-general",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }

    const executionState = opts?.lastAutoHandoffAt
      ? { lastAutoHandoffAt: opts.lastAutoHandoffAt.toISOString() }
      : null;

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implement feature X",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: engineerId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: new Date(heartbeatAt.getTime() - 30 * 60 * 1000),
      // updatedAt must be <= lastHeartbeatAt + 60 s for the activity-gap guard to pass.
      updatedAt: new Date(heartbeatAt.getTime() - 30 * 1000),
      executionState,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: engineerId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      startedAt: new Date(heartbeatAt.getTime() - 5 * 60 * 1000),
      finishedAt: heartbeatAt,
      updatedAt: heartbeatAt,
      createdAt: new Date(heartbeatAt.getTime() - 5 * 60 * 1000),
    });

    return { companyId, engineerId, reviewerId, runId, issueId };
  }

  // ---------------------------------------------------------------------------
  // A6a: positive trigger
  // ---------------------------------------------------------------------------

  it("hands off stranded in_progress issue to reviewer when threshold exceeded", async () => {
    const { companyId, engineerId, reviewerId, issueId } = await seedHandoffFixture();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedInProgressHandoffs({ now: FIXTURE_NOW });

    expect(result.handedOff).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    // Issue must be re-assigned to reviewer with status=todo.
    const updatedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(updatedIssue?.status).toBe("todo");
    expect(updatedIssue?.assigneeAgentId).toBe(reviewerId);

    // System comment must be posted with the fixed prefix line.
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(
      "Auto-handoff: Implementer concluded heartbeat without explicit hand-off. Please verify acceptance criteria.",
    );

    // Wakeup request must be enqueued for the reviewer.
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, reviewerId),
          eq(agentWakeupRequests.companyId, companyId),
        ),
      );
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      source: "assignment",
      triggerDetail: "system",
      reason: "auto_handoff_inprogress",
    });

    // executionState.lastAutoHandoffAt must be stamped for idempotency.
    const execState = updatedIssue?.executionState as Record<string, unknown> | null | undefined;
    expect(typeof execState?.lastAutoHandoffAt).toBe("string");

    // Let the triggered reviewer run settle so afterEach cleanup is not racing.
    const reviewerRun = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, reviewerId))
      .then((rows) => rows[0] ?? null);
    if (reviewerRun) {
      await waitForRunToSettle(heartbeatService(db), reviewerRun.id);
    }
  });

  // ---------------------------------------------------------------------------
  // A6b: idempotency skip (A5 — second trigger within 1 h)
  // ---------------------------------------------------------------------------

  it("skips issue already auto-handed-off within the 1 h idempotency window", async () => {
    // 30 min ago — well within the 1 h guard window.
    const recentHandoffAt = new Date(FIXTURE_NOW.getTime() - 30 * 60 * 1000);
    const { issueId } = await seedHandoffFixture({ lastAutoHandoffAt: recentHandoffAt });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedInProgressHandoffs({ now: FIXTURE_NOW });

    expect(result.handedOff).toBe(0);
    expect(result.skipped).toBe(1);

    // Issue status must remain unchanged.
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    // No comment must be posted.
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // A6c: missing-validator skip
  // ---------------------------------------------------------------------------

  it("skips issue when no reviewer/validator agent exists in the company", async () => {
    const { issueId } = await seedHandoffFixture({ noReviewer: true });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedInProgressHandoffs({ now: FIXTURE_NOW });

    expect(result.handedOff).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });

  // ---------------------------------------------------------------------------
  // Additional guard: non-engineer-role assignee is skipped
  // ---------------------------------------------------------------------------

  it("skips issue assigned to a non-engineer-role agent", async () => {
    const { issueId } = await seedHandoffFixture({ engineerRole: "manager" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedInProgressHandoffs({ now: FIXTURE_NOW });

    expect(result.handedOff).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });

  // ---------------------------------------------------------------------------
  // Additional guard: not enough time elapsed yet
  // ---------------------------------------------------------------------------

  it("skips issue whose last succeeded heartbeat is within the threshold window", async () => {
    // Heartbeat finished only 5 min ago — inside the 10 min threshold.
    const recentHeartbeatAt = new Date(FIXTURE_NOW.getTime() - 5 * 60 * 1000);
    const { issueId } = await seedHandoffFixture({ lastHeartbeatAt: recentHeartbeatAt });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedInProgressHandoffs({ now: FIXTURE_NOW });

    expect(result.handedOff).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });
});
