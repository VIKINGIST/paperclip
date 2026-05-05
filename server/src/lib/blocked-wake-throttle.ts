/**
 * Wake throttle predicates for issues in `blocked` status.
 *
 * Suppresses spurious wakes when no new user-substantive activity has occurred.
 * Preserves the UI banner promise: user comments always wake the assignee.
 */

export type WakeActorType = "agent" | "user" | "system" | "board";

/**
 * Returns true if a wake should be suppressed for a blocked issue.
 *
 * Rules:
 * - `issue_assigned`: suppress unless this is the initial assignment (null → agentId).
 * - `issue_commented`: suppress unless the actor is a human user.
 * - Any other status: never suppress (existing behavior unchanged).
 */
export function shouldThrottleBlockedIssueWake({
  issueStatus,
  eventType,
  actorType,
  previousAssigneeAgentId,
}: {
  issueStatus: string;
  eventType: "issue_assigned" | "issue_commented";
  actorType: WakeActorType;
  /** The assigneeAgentId BEFORE this update (null = was unassigned). */
  previousAssigneeAgentId?: string | null;
}): boolean {
  if (issueStatus !== "blocked") return false;

  if (eventType === "issue_assigned") {
    // Initial assignment (null → agentId) is legitimate triage — do not suppress.
    const isInitialAssignment = !previousAssigneeAgentId;
    return !isInitialAssignment;
  }

  // issue_commented: user comments always wake (preserves UX banner promise).
  return actorType !== "user";
}
