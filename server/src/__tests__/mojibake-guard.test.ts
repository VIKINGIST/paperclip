import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectMojibake } from "../lib/mojibake.js";

// ---------------------------------------------------------------------------
// Unit tests for detectMojibake()
// ---------------------------------------------------------------------------

describe("detectMojibake", () => {
  it("returns empty for clean Ukrainian text", () => {
    expect(detectMojibake("УЗО, Нульова шина, ДБН В.2.5-27")).toEqual([]);
  });

  it("returns empty for clean Russian text", () => {
    expect(detectMojibake("Автоматический выключатель, нулевая шина")).toEqual([]);
  });

  it("returns empty for ASCII-only text", () => {
    expect(detectMojibake("POST /api/issues description guard")).toEqual([]);
  });

  it("detects Р— (was Cyrillic З, UTF-8 0xD0 0x97 → Win-1251)", () => {
    const hits = detectMojibake("РЎРёРіРЅРЋС‚РёРЅРі Р— РќСЏ");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toBe("Р—");
  });

  it("detects Р– (was Cyrillic Ж, UTF-8 0xD0 0x96 → Win-1251)", () => {
    const hits = detectMojibake("Р–РµСЂРµР»Р°");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toBe("Р–");
  });

  it("detects РЈ (was Cyrillic У, UTF-8 0xD0 0xA3 → Win-1251)", () => {
    const hits = detectMojibake("РЈРЅРёС„С–РєРЅС–С‚СЊ");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toBe("РЈ");
  });

  it("detects вЂ (em-dash prefix, UTF-8 0xE2 0x80 → Win-1251)", () => {
    const hits = detectMojibake("вЂ em-dash test");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toBe("вЂ");
  });

  it("detects Сѓ (was Cyrillic у, UTF-8 0xD1 0x83 → Win-1251)", () => {
    const hits = detectMojibake("СЃС‚Сѓ пристрій");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toBe("Сѓ");
  });

  it("returns all distinct hits in a mixed corrupted string", () => {
    const hits = detectMojibake("Р— вЂ test Сѓ");
    expect(hits).toContain("Р—");
    expect(hits).toContain("вЂ");
    expect(hits).toContain("Сѓ");
  });

  it("returns empty for string with only one of the signature chars (no bigram)", () => {
    // "Р" alone is valid Cyrillic Р (er); "—" alone is a valid em-dash
    expect(detectMojibake("Р")).toEqual([]);
    expect(detectMojibake("—")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Route-level integration tests
// ---------------------------------------------------------------------------

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  update: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getRelationSummaries: vi.fn(async () => []),
  getDependencyReadiness: vi.fn(async () => ({ unresolvedBlockerCount: 0 })),
  getComment: vi.fn(),
  removeComment: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  hasPermission: vi.fn(async () => false),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

const mockIssueReferenceService = vi.hoisted(() => ({
  deleteDocumentSource: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));

function registerModuleMocks() {
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

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/feedback.js", () => ({
    feedbackService: () => mockFeedbackService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({ getById: vi.fn(async () => null) }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => mockFeedbackService,
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    issueApprovalService: () => ({}),
    issueReferenceService: () => mockIssueReferenceService,
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);

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

const COMPANY_ID = "company-1";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";

function makeCreatedIssue() {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "todo",
    assigneeAgentId: null,
    assigneeUserId: null,
    identifier: "ELE-105",
    title: "Clean issue",
    description: "Valid description",
    executionPolicy: null,
  };
}

function makeExistingIssue() {
  return {
    ...makeCreatedIssue(),
    status: "in_progress",
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    executionRunId: null,
  };
}

const MOJIBAKE_DESCRIPTION = "Р— вЂ implementation details Р–";
const CLEAN_DESCRIPTION = "УЗО, Нульова шина, ДБН В.2.5-27 — впровадження";

describe.sequential("mojibake guard — POST /companies/:companyId/issues", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/feedback.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.create.mockResolvedValue(makeCreatedIssue());
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue([COMPANY_ID]);
  });

  it("accepts clean Ukrainian text — 201", async () => {
    const res = await request(await installActor(createApp()))
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({ title: "УЗО 25A", description: CLEAN_DESCRIPTION });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("rejects mojibake in description — 400 with structured error", async () => {
    const res = await request(await installActor(createApp()))
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({ title: "Valid title", description: MOJIBAKE_DESCRIPTION });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("encoding_corrupted");
    expect(res.body.signatures).toBeDefined();
    expect(res.body.signatures.length).toBeGreaterThan(0);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects mojibake in title — 400", async () => {
    const res = await request(await installActor(createApp()))
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({ title: "Р— task title", description: "Clean description" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("encoding_corrupted");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects mixed (legit + corrupted) body — 400", async () => {
    const mixed = `${CLEAN_DESCRIPTION}\n\n${MOJIBAKE_DESCRIPTION}`;
    const res = await request(await installActor(createApp()))
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({ title: "Task", description: mixed });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("encoding_corrupted");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("allows mojibake with ?allowMojibake=true override — 201", async () => {
    const res = await request(await installActor(createApp()))
      .post(`/api/companies/${COMPANY_ID}/issues?allowMojibake=true`)
      .send({ title: "Valid title", description: MOJIBAKE_DESCRIPTION });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });
});

describe.sequential("mojibake guard — PATCH /issues/:id", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/feedback.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeExistingIssue());
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.update = vi.fn(async () => makeExistingIssue());
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue([COMPANY_ID]);
  });

  it("rejects mojibake description update — 400", async () => {
    const res = await request(await installActor(createApp()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ description: MOJIBAKE_DESCRIPTION });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("encoding_corrupted");
    expect(res.body.signatures).toBeDefined();
  });

  it("accepts clean Ukrainian description update", async () => {
    mockIssueService.update?.mockResolvedValue(makeExistingIssue());
    const res = await request(await installActor(createApp()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ description: CLEAN_DESCRIPTION });

    // 200 or 400 from unrelated validation is fine; just not encoding_corrupted
    expect(res.body.error).not.toBe("encoding_corrupted");
  });

  it("does not check mojibake when neither title nor description is updated", async () => {
    const res = await request(await installActor(createApp()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.body.error).not.toBe("encoding_corrupted");
  });
});
