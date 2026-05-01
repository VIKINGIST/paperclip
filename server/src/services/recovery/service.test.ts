import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { recoveryService } from "./service.js";

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
  issueTreeControlService: () => ({}),
}));

// Minimal drizzle-ORM chain mock:
//   .select([cols]).from(t).where(c).limit(n) → Promise<rows>
//   .select([cols]).from(t).innerJoin(t2,c).where(c).then(cb) → Promise
//   .select([cols]).from(t).where(c).then(cb) → Promise
function makeSelectChain(rows: unknown[]) {
  const thenable = {
    limit: () => Promise.resolve(rows),
    then: (cb: (r: unknown[]) => unknown) => Promise.resolve(cb(rows)),
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

  // DB call order for the blocked/cancelled/done path inside escalateStrandedAssignedIssue:
  //   1. ensureStrandedIssueRecoveryIssue: re-fetch source → inert status → early return, no create
  //   2. existingUnresolvedBlockerIssueIds: innerJoin query → no blockers
  //   3. issuesSvc.update → returns null → escalate returns null (no further DB calls)
  const inertStatuses = ["blocked", "cancelled", "done"] as const;

  for (const sourceStatus of inertStatuses) {
    it(`does NOT call issuesSvc.create when fresh DB status is '${sourceStatus}'`, async () => {
      const db = makeDb([
        [{ id: "src-1", status: sourceStatus }], // re-fetch in ensureStrandedIssueRecoveryIssue
        [], // existingUnresolvedBlockerIssueIds
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
    });
  }
});
