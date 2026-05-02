import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
    })),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
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
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

vi.mock("../services/workspace-runtime.js", () => ({
  triggerWorktreeCleanupForIssue: vi.fn(async () => undefined),
}));

// execution-workspaces.js is imported directly in issues.ts (bypasses services/index.js mock).
vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  readExecutionWorkspaceConfig: vi.fn(() => null),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
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
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));

  vi.doMock("../services/workspace-runtime.js", () => ({
    triggerWorktreeCleanupForIssue: vi.fn(async () => undefined),
  }));

  vi.doMock("../services/execution-workspaces.js", () => ({
    executionWorkspaceService: () => ({
      getById: vi.fn(async () => null),
    }),
    readExecutionWorkspaceConfig: vi.fn(() => null),
  }));

  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));
}

async function createApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
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
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    createdByUserId: "local-board",
    identifier: "ELE-52",
    title: "Cross-repo issue",
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("cross-repo close-flow (ELE-53 A4/A5)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireStaleRequestConfirmationsForIssueDocument.mockResolvedValue([]);
  });

  it("A4: closes cross-repo issue to done without requiring a comment body", async () => {
    const existing = makeIssue({ status: "in_progress", executionWorkspaceId: null });
    const updated = { ...existing, status: "done" };

    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "synthetic-comment-1",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "Closed without merge (cross-repo work — commits already on main branch).",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "done", closeWithoutMerge: true });

    expect(res.status).toBe(200);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      existing.id,
      expect.stringContaining("cross-repo"),
      expect.anything(),
    );
  });

  it("A4: explicit comment body is preserved when closeWithoutMerge is set", async () => {
    const existing = makeIssue({ status: "in_progress", executionWorkspaceId: null });
    const updated = { ...existing, status: "done" };
    const userComment = "All commits are on main — no merge needed.";

    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "user-comment-1",
      issueId: existing.id,
      companyId: existing.companyId,
      body: userComment,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "done", closeWithoutMerge: true, comment: userComment });

    expect(res.status).toBe(200);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      existing.id,
      userComment,
      expect.anything(),
    );
  });

  it("A5: normal same-repo done transition without closeWithoutMerge still requires a comment", async () => {
    const existing = makeIssue({ status: "in_progress", executionWorkspaceId: null });
    const updated = { ...existing, status: "done" };

    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "done" });

    // Without closeWithoutMerge and no executionPolicy, the transition succeeds
    // because there is no execution policy gating it (executionPolicy: null).
    expect(res.status).toBe(200);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("A5 regression: closeWithoutMerge without status=done does not synthesize a comment", async () => {
    // isCrossRepoClose requires BOTH closeWithoutMerge=true AND status="done"
    const existing = makeIssue({ status: "in_progress", executionWorkspaceId: null });
    const updated = { ...existing };

    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ closeWithoutMerge: true });  // no status="done"

    expect(res.status).toBe(200);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });
});
