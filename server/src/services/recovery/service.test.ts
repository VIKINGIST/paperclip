import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { classifyHandoffDiff, recoveryService } from "./service.js";

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockAddComment = vi.fn();

vi.mock("../issues.js", () => ({
  issueService: () => ({
    create: mockCreate,
    update: mockUpdate,
    addComment: mockAddComment,
    getRelationSummaries: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock("../activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../issue-tree-control.js", () => ({
  issueTreeControlService: () => ({
    getActivePauseHoldGate: vi.fn().mockResolvedValue(null),
  }),
}));

// Minimal drizzle-ORM chain mock:
//   .select([cols]).from(t).where(c).limit(n) → Promise<rows>
//   .select([cols]).from(t).where(c).orderBy(...).limit(n).then(cb) → Promise
//   .select([cols]).from(t).innerJoin(t2,c).where(c).then(cb) → Promise
//   .select([cols]).from(t).where(c).then(cb) → Promise
function makeSelectChain(rows: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const thenable: Record<string, any> = {
    limit: () => Promise.resolve(rows),
    then: (cb: (r: unknown[]) => unknown) => Promise.resolve(cb(rows)),
    orderBy: () => thenable,
  };
  const chain: Record<string, () => unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => thenable,
  };
  return chain;
}

function makeDb(selectResponses: unknown[][]): Db {
  let callCount = 0;
  return {
    select: vi.fn(() => makeSelectChain(selectResponses[callCount++] ?? [])),
    insert: vi.fn(() => ({ values: () => Promise.resolve([]) })),
  } as unknown as Db;
}

describe("ensureStrandedIssueRecoveryIssue status gate (ELE-32)", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset().mockResolvedValue(null); // returns null → escalate returns early
    mockAddComment.mockReset().mockResolvedValue(undefined);
  });

  // bemsas review (blocking): when fresh DB status is inert, escalation must
  // ALSO short-circuit BEFORE calling issuesSvc.update — otherwise the
  // status=blocked update would resurrect a done/cancelled source.
  // DB call order for the inert path inside escalateStrandedAssignedIssue:
  //   1. ensureStrandedIssueRecoveryIssue: re-fetch source → inert status → return { skipReason: 'inert_status' }
  //   (no further DB calls; caller early-returns before existingUnresolvedBlockerIssueIds)
  const inertStatuses = ["blocked", "cancelled", "done"] as const;

  for (const sourceStatus of inertStatuses) {
    it(`does NOT call issuesSvc.create OR issuesSvc.update when fresh DB status is '${sourceStatus}'`, async () => {
      const db = makeDb([
        [{ id: "src-1", status: sourceStatus }], // re-fetch in ensureStrandedIssueRecoveryIssue
      ]);

      const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });

      const fakeIssue = {
        id: "src-1",
        companyId: "co-1",
        status: "in_progress", // stale; DB re-fetch returns inert
        originKind: null,
        identifier: "ELE-19",
        title: "Test issue",
        priority: "medium",
        projectId: null,
        goalId: null,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        billingCode: null,
        hiddenAt: null,
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      await svc.escalateStrandedAssignedIssue({
        issue: fakeIssue,
        previousStatus: "in_progress",
        latestRun: null,
        comment: "recovery escalation",
      });

      expect(mockCreate).not.toHaveBeenCalled();
      // Critical for bemsas-blocking #1: update MUST NOT fire on inert source.
      expect(mockUpdate).not.toHaveBeenCalled();
      // Exactly 1 select call = freshSource only; the early-return in the caller
      // prevents any subsequent queries (existingUnresolvedBlockerIssueIds etc).
      expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });
  }
});

// Base issue used by ELE-36 gate tests.
// assigneeAgentId and createdByAgentId are null so resolveStrandedIssueRecoveryOwnerAgentId
// only does one role-candidates select before returning null (no owner → no create).
const ele36BaseIssue = {
  id: "src-1",
  companyId: "co-1",
  status: "in_progress",
  originKind: null,
  identifier: "ELE-19",
  title: "Test issue",
  priority: "medium",
  projectId: null,
  goalId: null,
  assigneeAgentId: null,
  assigneeUserId: null,
  createdByAgentId: null,
  billingCode: null,
  hiddenAt: null,
  parentId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe("ensureStrandedIssueRecoveryIssue sibling-time-window gate (ELE-36)", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset().mockResolvedValue(null);
    mockAddComment.mockReset().mockResolvedValue(undefined);
  });

  // bemsas review (blocking): when an OPEN recovery sibling exists within the 5-min
  // window, the gate suppresses creation AND returns the sibling so the caller can
  // link source.blockedByIssueIds → sibling.id (preserves the pre-iter-2 race-conflict
  // catch-block invariant).
  // DB call order:
  //   1. freshSource → in_progress
  //   2. sibling check → [open sibling found] → return { recovery: sibling, skipReason: 'recent_sibling' }
  //   3. existingUnresolvedBlockerIssueIds (caller proceeds to update)
  //   4. (issuesSvc.update is mocked; no extra DB call)
  it("returns OPEN sibling for linkage when a recovery sibling was created 4 min ago", async () => {
    const db = makeDb([
      [{ id: "src-1", status: "in_progress" }],                    // freshSource
      [{ id: "sib-1", status: "in_progress", hiddenAt: null }],   // open sibling
      [],                                                            // existingUnresolvedBlockerIssueIds
    ]);

    mockUpdate.mockResolvedValueOnce({ id: "src-1" }); // simulate successful update so caller proceeds

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    await svc.escalateStrandedAssignedIssue({
      issue: ele36BaseIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "recovery escalation",
    });

    expect(mockCreate).not.toHaveBeenCalled();
    // Caller MUST link source.blockedByIssueIds to the open sibling's id.
    expect(mockUpdate).toHaveBeenCalledWith(
      "src-1",
      expect.objectContaining({
        status: "blocked",
        blockedByIssueIds: ["sib-1"],
      }),
    );
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  // bemsas review (blocking): a CLOSED sibling within the window must NOT be
  // linked (linking source to a `done` recovery is misleading). Gate still
  // suppresses creation — debounce semantics — but recoveryIssue is null,
  // so blockedByIssueIds stays empty.
  it("suppresses creation but does NOT link when sibling within window is closed", async () => {
    const db = makeDb([
      [{ id: "src-1", status: "in_progress" }],                    // freshSource
      [{ id: "sib-1", status: "done", hiddenAt: null }],           // closed sibling
      [],                                                            // existingUnresolvedBlockerIssueIds
    ]);

    mockUpdate.mockResolvedValueOnce({ id: "src-1" });

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    await svc.escalateStrandedAssignedIssue({
      issue: ele36BaseIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "recovery escalation",
    });

    expect(mockCreate).not.toHaveBeenCalled();
    // Critical: blockedByIssueIds must be EMPTY — closed sibling is not a valid blocker.
    expect(mockUpdate).toHaveBeenCalledWith(
      "src-1",
      expect.objectContaining({
        status: "blocked",
        blockedByIssueIds: [],
      }),
    );
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  // Hidden sibling (hiddenAt set) is treated the same as closed — no linkage.
  it("suppresses creation but does NOT link when sibling within window is hidden", async () => {
    const db = makeDb([
      [{ id: "src-1", status: "in_progress" }],
      [{ id: "sib-1", status: "in_progress", hiddenAt: new Date() }], // open status, but hidden
      [],
    ]);

    mockUpdate.mockResolvedValueOnce({ id: "src-1" });

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    await svc.escalateStrandedAssignedIssue({
      issue: ele36BaseIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "recovery escalation",
    });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(
      "src-1",
      expect.objectContaining({ blockedByIssueIds: [] }),
    );
  });

  // DB call order when sibling is outside window (allowed path):
  //   1. freshSource → in_progress
  //   2. sibling check → [] (6 min is outside 5-min window)
  //   3. [FOR OPS] check → []
  //   4. findOpenStrandedIssueRecoveryIssue → []
  //   5. roleCandidates (CTO/CEO) → [] → no owner → return null
  //   6. existingUnresolvedBlockerIssueIds
  it("proceeds past sibling gate when the only sibling was created 6 min ago", async () => {
    const db = makeDb([
      [{ id: "src-1", status: "in_progress" }], // freshSource
      [],                                         // sibling check → empty (outside window)
      [],                                         // [FOR OPS] check
      [],                                         // findOpenStrandedIssueRecoveryIssue
      [],                                         // roleCandidates → no owner → return null
      [],                                         // existingUnresolvedBlockerIssueIds
    ]);

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    await svc.escalateStrandedAssignedIssue({
      issue: ele36BaseIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "recovery escalation",
    });

    expect(mockCreate).not.toHaveBeenCalled(); // no owner found, not a gate skip
    // 6 select calls confirms the function reached findOpenStrandedIssueRecoveryIssue
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(6);
  });
});

describe("ensureStrandedIssueRecoveryIssue [FOR OPS]-active gate (ELE-36)", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset().mockResolvedValue(null);
    mockAddComment.mockReset().mockResolvedValue(undefined);
  });

  // DB call order when ops issue found (skipped path):
  //   1. freshSource → in_progress
  //   2. sibling check → []
  //   3. [FOR OPS] check → [found] → early return null
  //   4. existingUnresolvedBlockerIssueIds
  it("does NOT call issuesSvc.create when an open [FOR OPS] issue mentions source.identifier", async () => {
    const db = makeDb([
      [{ id: "src-1", status: "in_progress" }], // freshSource
      [],                                         // sibling check → empty
      [{ id: "ops-1" }],                         // [FOR OPS] check → found → skip
      [],                                         // existingUnresolvedBlockerIssueIds
    ]);

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    await svc.escalateStrandedAssignedIssue({
      issue: ele36BaseIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "recovery escalation",
    });

    expect(mockCreate).not.toHaveBeenCalled();
    // 4 select calls confirms early return from [FOR OPS] gate
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  // Closed [FOR OPS] issue is filtered out by notInArray(status, ['done','cancelled'])
  // so the DB returns [] and the gate does not fire.
  it("proceeds past [FOR OPS] gate when the matching issue is closed (done/cancelled)", async () => {
    const db = makeDb([
      [{ id: "src-1", status: "in_progress" }], // freshSource
      [],                                         // sibling check → empty
      [],                                         // [FOR OPS] check → empty (closed issues filtered)
      [],                                         // findOpenStrandedIssueRecoveryIssue
      [],                                         // roleCandidates → no owner
      [],                                         // existingUnresolvedBlockerIssueIds
    ]);

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    await svc.escalateStrandedAssignedIssue({
      issue: ele36BaseIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "recovery escalation",
    });

    expect(mockCreate).not.toHaveBeenCalled(); // no owner found, not a gate skip
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(6);
  });

  // [FOR OPS] issue exists but description does not mention source.identifier so ilike fails
  // → DB returns [] and gate does not fire.
  it("proceeds past [FOR OPS] gate when no [FOR OPS] issue mentions source.identifier", async () => {
    const db = makeDb([
      [{ id: "src-1", status: "in_progress" }], // freshSource
      [],                                         // sibling check → empty
      [],                                         // [FOR OPS] check → empty (ilike no match)
      [],                                         // findOpenStrandedIssueRecoveryIssue
      [],                                         // roleCandidates → no owner
      [],                                         // existingUnresolvedBlockerIssueIds
    ]);

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    await svc.escalateStrandedAssignedIssue({
      issue: ele36BaseIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "recovery escalation",
    });

    expect(mockCreate).not.toHaveBeenCalled(); // no owner found, not a gate skip
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(6);
  });
});

// ─── reconcileStrandedInProgressHandoffs (ELE-64) ────────────────────────────
//
// DB call order for a candidate issue (one per DB select() call):
//   0. candidates       → issues with status=in_progress, assigneeAgentId IS NOT NULL
//   1. getAgent         → agents table for the assignee
//   2. hasActiveExec    → heartbeatRuns (active run check)
//   3. hasActiveExec    → agentWakeupRequests (deferred wake check)  [Promise.all with #2]
//   4. latestSucceeded  → heartbeatRuns with status=succeeded + issueId
//   5. newRunAfter      → heartbeatRuns created after last succeeded run
//   6. newCommentAfter  → issueComments created after last succeeded run
//   ── idempotency check from issue.executionState (no DB call) ──
//   7. validatorAgent   → agents with reviewer/architect-reviewer role or Reviewer-* name
//   8. recentComments   → issueComments by assignee agent (last 2)
//   then: issuesSvc.update, issuesSvc.addComment, logActivity, enqueueWakeup
//
describe("reconcileStrandedInProgressHandoffs (ELE-64)", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  // 15 min ago — older than the 10-min INPROGRESS_HANDOFF_TIMEOUT_MS default
  const OLD_HEARTBEAT = new Date(now.getTime() - 15 * 60 * 1000);
  // 5 min ago — within the 10-min timeout window
  const RECENT_HEARTBEAT = new Date(now.getTime() - 5 * 60 * 1000);
  // 30 min ago — within the 1-h idempotency window
  const IDEMPOTENCY_RECENT = new Date(now.getTime() - 30 * 60 * 1000);

  const engineerAgent = { id: "agent-1", companyId: "co-1", role: "engineer", name: "Implementer-1" };
  const reviewerAgent = { id: "reviewer-1", companyId: "co-1", role: "architect-reviewer", name: "Reviewer-1" };
  const succeededRun = { id: "run-1", agentId: "agent-1", status: "succeeded", finishedAt: OLD_HEARTBEAT };

  // issue.updatedAt is 20 min ago — before lastHeartbeatAt (15 min ago) + 60 s grace.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseIssue: any = {
    id: "issue-1",
    companyId: "co-1",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    hiddenAt: null,
    updatedAt: new Date(now.getTime() - 20 * 60 * 1000),
    executionState: null,
    identifier: "ELE-99",
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset().mockResolvedValue({ id: "issue-1" });
    mockAddComment.mockReset().mockResolvedValue(undefined);
  });

  it("hands off in_progress engineer issue to reviewer after timeout", async () => {
    const db = makeDb([
      [baseIssue],     // 0. candidates
      [engineerAgent], // 1. getAgent
      [],              // 2. hasActiveExecutionPath – run
      [],              // 3. hasActiveExecutionPath – deferredWake
      [succeededRun],  // 4. getLatestSucceededIssueRun
      [],              // 5. newRunAfter
      [],              // 6. newCommentAfter
      [reviewerAgent], // 7. validatorAgent
      [],              // 8. recentAgentComments
    ]);

    const enqueueWakeup = vi.fn().mockResolvedValue(undefined);
    const svc = recoveryService(db, { enqueueWakeup });
    const result = await svc.reconcileStrandedInProgressHandoffs({ now });

    expect(result.handedOff).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.issueIds).toEqual(["issue-1"]);
    expect(mockUpdate).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({ assigneeAgentId: "reviewer-1", status: "todo" }),
    );
    expect(mockAddComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Auto-handoff: Implementer concluded heartbeat without explicit hand-off."),
      expect.anything(),
    );
    expect(enqueueWakeup).toHaveBeenCalledWith(
      "reviewer-1",
      expect.objectContaining({ reason: "auto_handoff_inprogress" }),
    );
  });

  // Idempotency guard: lastAutoHandoffAt is 30 min ago (within the 1-h window).
  // The check reads issue.executionState — no extra DB call — so the sequence
  // stops at call 6 (newCommentAfter) and skips without touching the validator query.
  it("skips without update when lastAutoHandoffAt is within the 1-hour idempotency window", async () => {
    const idempotentIssue = {
      ...baseIssue,
      executionState: { lastAutoHandoffAt: IDEMPOTENCY_RECENT.toISOString() },
    };
    const db = makeDb([
      [idempotentIssue], // 0. candidates
      [engineerAgent],   // 1. getAgent
      [],                // 2. hasActiveExecutionPath – run
      [],                // 3. hasActiveExecutionPath – deferredWake
      [succeededRun],    // 4. getLatestSucceededIssueRun
      [],                // 5. newRunAfter
      [],                // 6. newCommentAfter
      // idempotency fires from executionState; calls 7+ not reached
    ]);

    const enqueueWakeup = vi.fn().mockResolvedValue(undefined);
    const svc = recoveryService(db, { enqueueWakeup });
    const result = await svc.reconcileStrandedInProgressHandoffs({ now });

    expect(result.skipped).toBe(1);
    expect(result.handedOff).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(enqueueWakeup).not.toHaveBeenCalled();
    // Exactly 7 select calls (0–6); no validator query at call 7.
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(7);
  });

  // Missing validator: no reviewer-role agent found in the company.
  // The function logs a warning and skips without patching or commenting.
  it("skips and does not update when no validator agent exists in the company", async () => {
    const db = makeDb([
      [baseIssue],     // 0. candidates
      [engineerAgent], // 1. getAgent
      [],              // 2. hasActiveExecutionPath – run
      [],              // 3. hasActiveExecutionPath – deferredWake
      [succeededRun],  // 4. getLatestSucceededIssueRun
      [],              // 5. newRunAfter
      [],              // 6. newCommentAfter
      [],              // 7. validatorAgent → empty (no reviewer found)
    ]);

    const enqueueWakeup = vi.fn().mockResolvedValue(undefined);
    const svc = recoveryService(db, { enqueueWakeup });
    const result = await svc.reconcileStrandedInProgressHandoffs({ now });

    expect(result.skipped).toBe(1);
    expect(result.handedOff).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  // Skip: assignee has a non-engineer role — the detector must only fire for engineers.
  it("skips when assignee agent has a non-engineer role", async () => {
    const architectAgent = { id: "agent-1", companyId: "co-1", role: "architect", name: "Architect-1" };
    const db = makeDb([
      [baseIssue],      // 0. candidates
      [architectAgent], // 1. getAgent → not engineer → skip
    ]);

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    const result = await svc.reconcileStrandedInProgressHandoffs({ now });

    expect(result.skipped).toBe(1);
    expect(result.handedOff).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
    // Only 2 select calls before the early continue.
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  // Skip: the last succeeded heartbeat is within the 10-min timeout window.
  it("skips when last heartbeat finished within the timeout window", async () => {
    const db = makeDb([
      [baseIssue],                                                      // 0. candidates
      [engineerAgent],                                                   // 1. getAgent
      [],                                                                // 2. hasActiveExecutionPath – run
      [],                                                                // 3. hasActiveExecutionPath – deferredWake
      [{ ...succeededRun, finishedAt: RECENT_HEARTBEAT }],              // 4. recent run (within 10 min)
    ]);

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    const result = await svc.reconcileStrandedInProgressHandoffs({ now });

    expect(result.skipped).toBe(1);
    expect(result.handedOff).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reconcileStrandedInProgressHandoffs (ELE-64)
// DB call order per candidate (happy path):
//   0  candidates query
//   1  getAgent(agentId)
//   2  hasActiveExecutionPath – heartbeatRuns active run check  (Promise.all slot A)
//   3  hasActiveExecutionPath – agentWakeupRequests deferred check (Promise.all slot B)
//   4  getLatestSucceededIssueRun
//   5  newRunAfter check
//   6  newCommentAfter check
//   7  validatorAgent lookup
//   8  recentAgentComments
// ---------------------------------------------------------------------------
describe("reconcileStrandedInProgressHandoffs (ELE-64)", () => {
  const NOW = new Date("2025-01-01T12:00:00Z");
  // 15 min ago — beyond 10 min threshold → should trigger handoff
  const OLD_HEARTBEAT = new Date("2025-01-01T11:45:00Z");
  // 5 min ago — within 10 min threshold → should NOT trigger
  const RECENT_HEARTBEAT = new Date("2025-01-01T11:55:00Z");

  const baseIssue = {
    id: "issue-1",
    companyId: "co-1",
    projectId: "proj-1",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    hiddenAt: null,
    updatedAt: new Date("2025-01-01T11:40:00Z"),
    executionState: {},
    identifier: "ELE-TEST-1",
  };

  const engineerAgent = { id: "agent-1", companyId: "co-1", role: "engineer", name: "Implementer-1" };
  const validatorAgentRow = { id: "reviewer-1", name: "Reviewer-1", role: "architect-reviewer" };
  const oldRun = { id: "run-1", finishedAt: OLD_HEARTBEAT };

  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset().mockResolvedValue(null);
    mockAddComment.mockReset().mockResolvedValue(undefined);
  });

  it("A6-positive: hands off to validator when threshold exceeded", async () => {
    mockUpdate.mockResolvedValue({ id: "issue-1" });
    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const db = makeDb([
      [baseIssue],          // 0 candidates
      [engineerAgent],      // 1 getAgent
      [],                   // 2 hasActiveExecutionPath – runs
      [],                   // 3 hasActiveExecutionPath – wakes
      [oldRun],             // 4 getLatestSucceededIssueRun
      [],                   // 5 newRunAfter
      [],                   // 6 newCommentAfter
      [validatorAgentRow],  // 7 validatorAgent
      [],                   // 8 recentAgentComments
    ]);
    const svc = recoveryService(db, { enqueueWakeup });

    const result = await svc.reconcileStrandedInProgressHandoffs({ now: NOW });

    expect(result.handedOff).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mockUpdate).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({ assigneeAgentId: "reviewer-1", status: "todo" }),
    );
    expect(mockAddComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Auto-handoff: Implementer concluded heartbeat without explicit hand-off."),
      {},
    );
    expect(enqueueWakeup).toHaveBeenCalledWith(
      "reviewer-1",
      expect.objectContaining({ reason: "auto_handoff_inprogress" }),
    );
  });

  it("A6-idempotency: skips and logs when lastAutoHandoffAt is within 1h", async () => {
    const issueWithRecentHandoff = {
      ...baseIssue,
      executionState: { lastAutoHandoffAt: "2025-01-01T11:30:00Z" }, // 30 min ago
    };
    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const db = makeDb([
      [issueWithRecentHandoff], // 0 candidates
      [engineerAgent],          // 1 getAgent
      [],                       // 2 hasActiveExecutionPath – runs
      [],                       // 3 hasActiveExecutionPath – wakes
      [oldRun],                 // 4 getLatestSucceededIssueRun
      [],                       // 5 newRunAfter
      [],                       // 6 newCommentAfter
      // idempotency guard fires here — no more DB calls
    ]);
    const svc = recoveryService(db, { enqueueWakeup });

    const result = await svc.reconcileStrandedInProgressHandoffs({ now: NOW });

    expect(result.handedOff).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("A6-no-validator: skips and emits warning when no validator agent in company", async () => {
    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const db = makeDb([
      [baseIssue],         // 0 candidates
      [engineerAgent],     // 1 getAgent
      [],                  // 2 hasActiveExecutionPath – runs
      [],                  // 3 hasActiveExecutionPath – wakes
      [oldRun],            // 4 getLatestSucceededIssueRun
      [],                  // 5 newRunAfter
      [],                  // 6 newCommentAfter
      [],                  // 7 validatorAgent lookup → empty
    ]);
    const svc = recoveryService(db, { enqueueWakeup });

    const result = await svc.reconcileStrandedInProgressHandoffs({ now: NOW });

    expect(result.handedOff).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("A6-non-engineer: skips issue assigned to non-engineer agent", async () => {
    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const db = makeDb([
      [baseIssue],                              // 0 candidates
      [{ ...engineerAgent, role: "ceo" }],      // 1 getAgent → not engineer
    ]);
    const svc = recoveryService(db, { enqueueWakeup });

    const result = await svc.reconcileStrandedInProgressHandoffs({ now: NOW });

    expect(result.handedOff).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("A6-within-threshold: skips issue whose last heartbeat is within the timeout window", async () => {
    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const db = makeDb([
      [baseIssue],
      [engineerAgent],
      [],   // hasActiveExecutionPath – runs
      [],   // hasActiveExecutionPath – wakes
      [{ id: "run-2", finishedAt: RECENT_HEARTBEAT }], // 4 recent succeeded run
    ]);
    const svc = recoveryService(db, { enqueueWakeup });

    const result = await svc.reconcileStrandedInProgressHandoffs({ now: NOW });

    expect(result.handedOff).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ELE-64: reconcileStrandedInProgressHandoffs unit tests (A6)
describe("reconcileStrandedInProgressHandoffs (ELE-64)", () => {
  const now = new Date("2026-05-03T12:00:00.000Z");
  // 700 s (≈11.7 min) ago — past the 600 s / 10-min default threshold
  const lastHeartbeatAt = new Date(now.getTime() - 700_000);

  const baseIssue = {
    id: "issue-1",
    companyId: "co-1",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    hiddenAt: null,
    updatedAt: lastHeartbeatAt,
    executionState: null,
    identifier: "ELE-99",
    title: "Test issue",
    priority: "medium",
    projectId: null,
    goalId: null,
    originKind: null,
    parentId: null,
    billingCode: null,
    checkoutRunId: null,
    executionRunId: null,
    createdAt: new Date(now.getTime() - 3_600_000),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const engineerAgent = {
    id: "agent-1",
    companyId: "co-1",
    role: "engineer",
    name: "Implementer-1",
    status: "idle",
  };

  const succeededRun = {
    id: "run-1",
    agentId: "agent-1",
    status: "succeeded",
    finishedAt: lastHeartbeatAt,
  };

  const reviewerAgent = {
    id: "reviewer-1",
    name: "Reviewer-1",
    role: "reviewer-core",
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset().mockResolvedValue(null);
    mockAddComment.mockReset().mockResolvedValue(undefined);
  });

  // A6 — positive trigger: engineer-role assignee, succeeded run > threshold ago,
  // no new activity, no idempotency marker → hands off to reviewer.
  // DB call order:
  //   1. candidates scan → [baseIssue]
  //   2. getAgent(agent-1) → [engineerAgent]
  //   3. hasActiveExecutionPath: active runs → []
  //   4. hasActiveExecutionPath: deferred wakeups → []
  //   5. getLatestSucceededIssueRun → [succeededRun]
  //   6. newRunAfter → []
  //   7. newCommentAfter → []
  //   8. validatorAgent → [reviewerAgent]
  //   9. recentAgentComments → []
  it("hands off to reviewer when engineer run succeeded > threshold ago with no new activity", async () => {
    const db = makeDb([
      [baseIssue],          // candidates
      [engineerAgent],      // getAgent
      [],                   // hasActiveExecutionPath: runs
      [],                   // hasActiveExecutionPath: wakeup requests
      [succeededRun],       // getLatestSucceededIssueRun
      [],                   // newRunAfter
      [],                   // newCommentAfter
      [reviewerAgent],      // validatorAgent
      [],                   // recentAgentComments
    ]);

    mockUpdate.mockResolvedValueOnce({ id: "issue-1" });

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    const result = await svc.reconcileStrandedInProgressHandoffs({ now });

    expect(result.handedOff).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mockUpdate).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({
        assigneeAgentId: "reviewer-1",
        status: "todo",
      }),
    );
    expect(mockAddComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Auto-handoff: Implementer concluded heartbeat without explicit hand-off."),
      expect.anything(),
    );
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(9);
  });

  // A6 — idempotency skip: issue was already auto-handed-off 30 min ago (< 1h).
  // DB call order:
  //   1. candidates → [issue with lastAutoHandoffAt 30 min ago]
  //   2. getAgent → [engineerAgent]
  //   3. hasActiveExecutionPath: runs → []
  //   4. hasActiveExecutionPath: wakeups → []
  //   5. getLatestSucceededIssueRun → [succeededRun]
  //   6. newRunAfter → []
  //   7. newCommentAfter → []
  //   (idempotency guard fires → skip; no validator lookup)
  it("emits recovery.auto_handoff_skipped_recent and does NOT hand off within 1h of last auto-handoff", async () => {
    const recentHandoffAt = new Date(now.getTime() - 1_800_000).toISOString(); // 30 min ago
    const issueWithHandoff = {
      ...baseIssue,
      executionState: { lastAutoHandoffAt: recentHandoffAt },
    };

    const db = makeDb([
      [issueWithHandoff],   // candidates
      [engineerAgent],      // getAgent
      [],                   // hasActiveExecutionPath: runs
      [],                   // hasActiveExecutionPath: wakeups
      [succeededRun],       // getLatestSucceededIssueRun
      [],                   // newRunAfter
      [],                   // newCommentAfter
    ]);

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    const result = await svc.reconcileStrandedInProgressHandoffs({ now });

    expect(result.handedOff).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(7);
  });

  // A6 — missing-validator skip: no reviewer agent found in the company →
  // warning logged, no PATCH, no comment.
  // DB call order:
  //   1. candidates
  //   2. getAgent
  //   3. hasActiveExecutionPath: runs
  //   4. hasActiveExecutionPath: wakeups
  //   5. getLatestSucceededIssueRun
  //   6. newRunAfter
  //   7. newCommentAfter
  //   8. validatorAgent → [] (none found)
  it("skips with warning when no validator agent exists in the company", async () => {
    const db = makeDb([
      [baseIssue],     // candidates
      [engineerAgent], // getAgent
      [],              // hasActiveExecutionPath: runs
      [],              // hasActiveExecutionPath: wakeups
      [succeededRun],  // getLatestSucceededIssueRun
      [],              // newRunAfter
      [],              // newCommentAfter
      [],              // validatorAgent → empty
    ]);

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    const result = await svc.reconcileStrandedInProgressHandoffs({ now });

    expect(result.handedOff).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(8);
  });

  // ELE-104 — terminal state guard:
  // Simulates the race: operator cancels ELE-99 between the candidate-query
  // snapshot (status=in_progress) and the issuesSvc.update call.
  // issuesSvc.update re-reads the DB, finds status=cancelled, and returns null.
  // reconcileStrandedInProgressHandoffs must skip gracefully — no comment, no wakeup.
  // DB call order:
  //   1. candidates → [baseIssue (in_progress snapshot)]
  //   2. getAgent → [engineerAgent]
  //   3. hasActiveExecutionPath: runs → []
  //   4. hasActiveExecutionPath: wakeups → []
  //   5. getLatestSucceededIssueRun → [succeededRun]
  //   6. newRunAfter → []
  //   7. newCommentAfter → []
  //   8. validatorAgent → [reviewerAgent]
  //   9. recentAgentComments → []
  //   (issuesSvc.update returns null — terminal guard blocked cron flip to done/todo)
  it("skips without comment or wakeup when issuesSvc.update returns null (ELE-104 terminal state guard)", async () => {
    // mockUpdate already defaults to null in beforeEach — no override needed.
    const db = makeDb([
      [baseIssue],     // candidates
      [engineerAgent], // getAgent
      [],              // hasActiveExecutionPath: runs
      [],              // hasActiveExecutionPath: wakeups
      [succeededRun],  // getLatestSucceededIssueRun
      [],              // newRunAfter
      [],              // newCommentAfter
      [reviewerAgent], // validatorAgent
      [],              // recentAgentComments
    ]);

    const enqueueWakeup = vi.fn().mockResolvedValue(undefined);
    const svc = recoveryService(db, { enqueueWakeup });
    const result = await svc.reconcileStrandedInProgressHandoffs({ now });

    expect(result.skipped).toBe(1);
    expect(result.handedOff).toBe(0);
    expect(result.issueIds).toEqual([]);
    // update must have been called (the guard fires inside issuesSvc, not before)
    expect(mockUpdate).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({ assigneeAgentId: "reviewer-1", status: "todo" }),
    );
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(9);
  });
});

// ─── A9: classifyHandoffDiff unit tests (ELE-64) ─────────────────────────────

describe("classifyHandoffDiff (ELE-64 A9)", () => {
  it("pure memory diff → AUTO_CLOSE", () => {
    const result = classifyHandoffDiff({
      diffNameOnly: ["memory/notes.md", "memory/context.canvas"],
      diffStatLines: "2 files changed, 10 insertions(+), 2 deletions(-)",
    });
    expect(result.tier).toBe("AUTO_CLOSE");
    expect(result.reason).toBe("safe-patterns-only");
    expect(result.files).toEqual(["memory/notes.md", "memory/context.canvas"]);
  });

  it("pure code diff → REVIEWER", () => {
    const result = classifyHandoffDiff({
      diffNameOnly: ["src/services/foo.ts"],
      diffStatLines: "1 file changed, 5 insertions(+)",
    });
    expect(result.tier).toBe("REVIEWER");
    expect(result.reason).toBe("contains-code-files");
  });

  it("mixed memory + code → REVIEWER", () => {
    const result = classifyHandoffDiff({
      diffNameOnly: ["memory/notes.md", "server/index.ts"],
      diffStatLines: "2 files changed, 20 insertions(+)",
    });
    expect(result.tier).toBe("REVIEWER");
    expect(result.reason).toBe("contains-code-files");
  });

  it("memory diff exceeding line limit → REVIEWER", () => {
    const result = classifyHandoffDiff({
      diffNameOnly: ["memory/bigfile.md"],
      diffStatLines: "1 file changed, 80 insertions(+), 30 deletions(-)",
      autoCloseLineLimit: 100,
    });
    expect(result.tier).toBe("REVIEWER");
    expect(result.reason).toBe("diff-exceeds-line-limit");
  });

  it("memory diff exactly at line limit → REVIEWER", () => {
    const result = classifyHandoffDiff({
      diffNameOnly: ["memory/notes.md"],
      diffStatLines: "1 file changed, 60 insertions(+), 40 deletions(-)",
      autoCloseLineLimit: 100,
    });
    expect(result.tier).toBe("REVIEWER");
    expect(result.reason).toBe("diff-exceeds-line-limit");
  });

  it("memory diff below line limit → AUTO_CLOSE", () => {
    const result = classifyHandoffDiff({
      diffNameOnly: ["memory/notes.md"],
      diffStatLines: "1 file changed, 50 insertions(+), 40 deletions(-)",
      autoCloseLineLimit: 100,
    });
    expect(result.tier).toBe("AUTO_CLOSE");
  });

  it("critical-path memory file → REVIEWER", () => {
    const result = classifyHandoffDiff({
      diffNameOnly: ["memory/critical-config.md"],
      diffStatLines: "1 file changed, 5 insertions(+)",
      criticalPathRegex: /critical-config/,
    });
    expect(result.tier).toBe("REVIEWER");
    expect(result.reason).toBe("critical-path-match");
  });

  it("zero diff with zero implementer comments → SKIP", () => {
    const result = classifyHandoffDiff({
      diffNameOnly: [],
      diffStatLines: "",
      recentImplementerCommentCount: 0,
    });
    expect(result.tier).toBe("SKIP");
    expect(result.reason).toBe("zero-diff-zero-comments");
  });

  it("zero diff with implementer comments → REVIEWER", () => {
    const result = classifyHandoffDiff({
      diffNameOnly: [],
      diffStatLines: "",
      recentImplementerCommentCount: 2,
    });
    expect(result.tier).toBe("REVIEWER");
    expect(result.reason).toBe("zero-diff-with-implementer-comments");
  });

  it("unsafe file pattern (non-md, non-code) → REVIEWER", () => {
    const result = classifyHandoffDiff({
      diffNameOnly: ["assets/icon.png"],
      diffStatLines: "1 file changed, 1 insertion(+)",
    });
    expect(result.tier).toBe("REVIEWER");
    expect(result.reason).toBe("unsafe-file-patterns");
  });

  it("README.md at root → AUTO_CLOSE", () => {
    const result = classifyHandoffDiff({
      diffNameOnly: ["README.md"],
      diffStatLines: "1 file changed, 3 insertions(+)",
    });
    expect(result.tier).toBe("AUTO_CLOSE");
  });

  it("docs md file → AUTO_CLOSE", () => {
    const result = classifyHandoffDiff({
      diffNameOnly: ["docs/architecture.md"],
      diffStatLines: "1 file changed, 8 insertions(+)",
    });
    expect(result.tier).toBe("AUTO_CLOSE");
  });

  it("adr file → AUTO_CLOSE", () => {
    const result = classifyHandoffDiff({
      diffNameOnly: ["decisions/0001-adr-initial.md"],
      diffStatLines: "1 file changed, 15 insertions(+)",
    });
    expect(result.tier).toBe("AUTO_CLOSE");
  });

  it("no critical-path regex (null) → AUTO_CLOSE for safe-only diff", () => {
    const result = classifyHandoffDiff({
      diffNameOnly: ["memory/notes.md"],
      diffStatLines: "1 file changed, 5 insertions(+)",
      criticalPathRegex: null,
    });
    expect(result.tier).toBe("AUTO_CLOSE");
  });
});
