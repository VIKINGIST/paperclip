import { describe, expect, it } from "vitest";
import { shouldThrottleBlockedIssueWake } from "../lib/blocked-wake-throttle.js";

describe("shouldThrottleBlockedIssueWake", () => {
  // ── Non-blocked issues ─────────────────────────────────────────────────────

  it("never throttles when issue is not blocked (in_progress)", () => {
    expect(
      shouldThrottleBlockedIssueWake({
        issueStatus: "in_progress",
        eventType: "issue_commented",
        actorType: "agent",
      }),
    ).toBe(false);
  });

  it("never throttles when issue is todo", () => {
    expect(
      shouldThrottleBlockedIssueWake({
        issueStatus: "todo",
        eventType: "issue_assigned",
        actorType: "agent",
        previousAssigneeAgentId: "prev-agent",
      }),
    ).toBe(false);
  });

  // ── issue_assigned on blocked issue ────────────────────────────────────────

  it("throttles issue_assigned when existing assignee is present (re-assignment on blocked)", () => {
    // Scenario 5 inverse: blocked, reassigned agent → no wake
    expect(
      shouldThrottleBlockedIssueWake({
        issueStatus: "blocked",
        eventType: "issue_assigned",
        actorType: "system",
        previousAssigneeAgentId: "existing-agent-uuid",
      }),
    ).toBe(true);
  });

  it("does NOT throttle issue_assigned when previous assignee is null (initial triage)", () => {
    // Scenario 5: null → agentId assignment on blocked → legitimate triage wake
    expect(
      shouldThrottleBlockedIssueWake({
        issueStatus: "blocked",
        eventType: "issue_assigned",
        actorType: "system",
        previousAssigneeAgentId: null,
      }),
    ).toBe(false);
  });

  it("does NOT throttle issue_assigned when previous assignee is undefined (initial triage)", () => {
    expect(
      shouldThrottleBlockedIssueWake({
        issueStatus: "blocked",
        eventType: "issue_assigned",
        actorType: "agent",
        previousAssigneeAgentId: undefined,
      }),
    ).toBe(false);
  });

  // ── issue_commented on blocked issue ───────────────────────────────────────

  it("throttles comment from agent (self heartbeat comment on blocked issue)", () => {
    // Scenario 1: agent posts own heartbeat → no wake
    expect(
      shouldThrottleBlockedIssueWake({
        issueStatus: "blocked",
        eventType: "issue_commented",
        actorType: "agent",
      }),
    ).toBe(true);
  });

  it("throttles comment from system (blocker-link update, NUMBERING NOTE)", () => {
    // Scenarios 2 & 6: system auto-handoff or NUMBERING NOTE → no wake
    expect(
      shouldThrottleBlockedIssueWake({
        issueStatus: "blocked",
        eventType: "issue_commented",
        actorType: "system",
      }),
    ).toBe(true);
  });

  it("throttles comment from board actor on blocked issue", () => {
    expect(
      shouldThrottleBlockedIssueWake({
        issueStatus: "blocked",
        eventType: "issue_commented",
        actorType: "board",
      }),
    ).toBe(true);
  });

  it("does NOT throttle comment from user (legitimate triage question)", () => {
    // Scenario 3: user posts question → wake fires (preserves UI banner promise)
    expect(
      shouldThrottleBlockedIssueWake({
        issueStatus: "blocked",
        eventType: "issue_commented",
        actorType: "user",
      }),
    ).toBe(false);
  });
});
