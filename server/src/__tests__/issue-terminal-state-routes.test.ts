/**
 * ELE-104: recovery cron must not auto-flip terminal-status issues.
 *
 * Regression guard for the session-251 incident: ELE-100 (recovery child)
 * completed → triggered "children_completed" wake on ELE-99 → Implementer-1
 * processed the stale wake and PATCHed ELE-99 to status=done even though the
 * operator had explicitly cancelled ELE-99 minutes earlier.
 *
 * The fix: the PATCH route returns 409 when an agent caller requests a status
 * transition out of a terminal state (done/cancelled). Only human-operator
 * (board/user) PATCHes may transition from terminal.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const agentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const runId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listAttachments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  removeAttachment: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));
  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));
  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));
  vi.doMock("../services/companies.js", () => ({
    companyService: () => mockCompanyService,
  }));
  vi.doMock("../services/documents.js", () => ({
    documentService: () => ({ upsertIssueDocument: vi.fn() }),
  }));
  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));
  vi.doMock("../services/issue-thread-interactions.js", () => ({
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
  }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companyService: () => mockCompanyService,
    documentService: () => ({ upsertIssueDocument: vi.fn() }),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({
      getById: vi.fn(async () => null),
      update: vi.fn(async () => null),
    }),
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "cancelled",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: agentId,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "ELE-99",
    title: "Stranded issue (cancelled by operator)",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    cancelledAt: new Date("2026-05-04T14:51:10Z"),
    completedAt: null,
    updatedAt: new Date("2026-05-04T14:51:10Z"),
    ...overrides,
  };
}

function agentActor() {
  return {
    type: "agent",
    agentId,
    companyId,
    source: "agent_key",
    runId,
  };
}

function boardActor() {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("ELE-104: terminal-state PATCH guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/companies.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/issue-thread-interactions.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");

    registerRouteMocks();
    vi.clearAllMocks();

    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockImplementation(async (id: string) =>
      id === agentId ? { id, companyId, role: "engineer", reportsTo: null, permissions: { canCreateAgents: false } } : null,
    );
    mockAgentService.list.mockResolvedValue([{ id: agentId, companyId, role: "engineer" }]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "ELE" });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.listAttachments.mockResolvedValue([]);
  });

  it("rejects agent PATCH cancelled→done with 409 (ELE-99/ELE-100 scenario)", async () => {
    // ELE-99 is cancelled. The recovery agent (Implementer-1) processes a stale
    // "children_completed" wake and tries to PATCH status=done.
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "cancelled" }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("terminal status 'cancelled'");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects agent PATCH done→todo with 409", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "done", cancelledAt: null, completedAt: new Date() }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("terminal status 'done'");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows human operator (board) to PATCH cancelled→todo", async () => {
    // Operator explicitly reopening a cancelled issue — must succeed.
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "cancelled" }));

    const res = await request(await createApp(boardActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ status: "todo", allowFromTerminal: true }),
    );
  });

  it("allows agent PATCH that does not change status on a cancelled issue (e.g. metadata update)", async () => {
    // Agent posting a comment or updating title without touching status — must not be blocked.
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "cancelled" }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Updated title" });

    // Title-only PATCH — no status change, so 409 guard must not fire.
    // The response may be 200 or 404/403 depending on other guards, but NOT 409.
    expect(res.status).not.toBe(409);
    // The terminal-transition guard specifically must not have blocked this.
    expect(res.body.error ?? "").not.toMatch(/terminal status/);
  });

  it("allows agent PATCH cancelled→cancelled (same status, no-op) without 409", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "cancelled" }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled" });

    // Same status — not a transition, guard must not fire.
    expect(res.status).not.toBe(409);
    expect(res.body.error ?? "").not.toMatch(/terminal status/);
  });
});
