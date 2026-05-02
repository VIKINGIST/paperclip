import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// B. Mock triggerWorktreeCleanupForIssue so route tests don't touch real git/fs.
const mockTriggerWorktreeCleanup = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../services/workspace-runtime.js", () => ({
  triggerWorktreeCleanupForIssue: mockTriggerWorktreeCleanup,
}));

// execution-workspaces.js is imported directly in issues.ts (not via services/index.js).
const mockExecutionWorkspaceGetById = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({
    getById: mockExecutionWorkspaceGetById,
  }),
  // readExecutionWorkspaceConfig is imported by workspace-runtime, keep it passable.
  readExecutionWorkspaceConfig: vi.fn(() => null),
}));

const mockExpireRequestConfirmations = vi.hoisted(() => vi.fn(async () => []));

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockAddComment = vi.hoisted(() => vi.fn(async (id: string, body: string) => ({
  id: `comment-${id}`,
  body,
  issueId: id,
  authorAgentId: null,
  authorUserId: "local-board",
  createdAt: new Date(),
  updatedAt: new Date(),
})));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(async () => []),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(async () => null),
  getCommentCursor: vi.fn(async () => ({ totalComments: 0, latestCommentId: null, latestCommentAt: null })),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  update: vi.fn(),
  addComment: mockAddComment,
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
    getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: false })),
  }),
  issueApprovalService: () => ({}),
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: mockExpireRequestConfirmations,
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({ addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [] }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("[test-error]", err?.message, err?.stack?.split("\n")[1]);
    res.status(500).json({ error: err?.message });
  });
  return app;
}

function baseIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "PAP-53",
    title: "Fleet hygiene",
    description: null,
    status: "in_progress",
    priority: "medium",
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionWorkspaceId: null,
    executionPolicy: null,
    executionState: null,
    executionWorkspacePreference: null,
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// B. Cleanup invariant: worktree removal triggered on status → done
// ---------------------------------------------------------------------------
describe("B. Cleanup invariant on status=done (ELE-53 B)", () => {
  it("calls triggerWorktreeCleanupForIssue when issue transitions to done with an executionWorkspaceId", async () => {
    const app = await createApp();
    mockIssueService.getById.mockResolvedValue(baseIssue({ executionWorkspaceId: "ws-99" }));
    mockIssueService.update.mockResolvedValue(baseIssue({ status: "done", executionWorkspaceId: "ws-99" }));

    const res = await request(app).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(mockTriggerWorktreeCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: "issue-1",
          workspaceId: "ws-99",
        }),
      );
    });
  });

  it("does NOT call triggerWorktreeCleanupForIssue when issue has no executionWorkspaceId", async () => {
    const app = await createApp();
    mockIssueService.getById.mockResolvedValue(baseIssue());
    mockIssueService.update.mockResolvedValue(baseIssue({ status: "done" }));

    const res = await request(app).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(mockWakeup).not.toHaveBeenCalled();
    });
    expect(mockTriggerWorktreeCleanup).not.toHaveBeenCalled();
  });

  it("does NOT call triggerWorktreeCleanupForIssue when status stays non-done", async () => {
    const app = await createApp();
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress", executionWorkspaceId: "ws-99" }));
    mockIssueService.update.mockResolvedValue(baseIssue({ status: "in_review", executionWorkspaceId: "ws-99" }));

    const res = await request(app).patch("/api/issues/issue-1").send({ status: "in_review" });
    expect(res.status).toBe(200);
    expect(mockTriggerWorktreeCleanup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// C. Cross-repo close: closeWithoutMerge flag (ELE-53 A4)
// ---------------------------------------------------------------------------
describe("C. Cross-repo close with closeWithoutMerge flag (ELE-53 A4)", () => {
  it("accepts status=done with closeWithoutMerge=true without requiring a manual comment", async () => {
    const app = await createApp();
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_review" }));
    mockIssueService.update.mockResolvedValue(baseIssue({ status: "done" }));

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({ status: "done", closeWithoutMerge: true });

    expect(res.status).toBe(200);
  });

  it("posts a synthesized comment when closeWithoutMerge=true and no comment provided", async () => {
    const app = await createApp();
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_review" }));
    mockIssueService.update.mockResolvedValue(baseIssue({ status: "done" }));

    const res2 = await request(app)
      .patch("/api/issues/issue-1")
      .send({ status: "done", closeWithoutMerge: true });
    if (res2.status !== 200) console.error("C.2 response:", res2.status, JSON.stringify(res2.body));

    expect(mockAddComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Closed without merge"),
      expect.any(Object),
    );
  });

  it("uses caller-provided comment when closeWithoutMerge=true and comment supplied", async () => {
    const app = await createApp();
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_review" }));
    mockIssueService.update.mockResolvedValue(baseIssue({ status: "done" }));

    await request(app)
      .patch("/api/issues/issue-1")
      .send({ status: "done", closeWithoutMerge: true, comment: "APPROVED: cross-repo work done." });

    expect(mockAddComment).toHaveBeenCalledWith(
      "issue-1",
      "APPROVED: cross-repo work done.",
      expect.any(Object),
    );
  });

  it("normal status=done without closeWithoutMerge still works (A5 regression guard)", async () => {
    const app = await createApp();
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_review" }));
    mockIssueService.update.mockResolvedValue(baseIssue({ status: "done" }));

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockAddComment).not.toHaveBeenCalled();
  });
});
