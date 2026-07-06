export const DEFAULT_AGENT_OFFLINE_AFTER_SECONDS = 90;

export function agentOfflineAfterSeconds() {
  const configured = Number(process.env.HOMESHARD_AGENT_OFFLINE_AFTER_SECS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_AGENT_OFFLINE_AFTER_SECONDS;
}

export function isAgentOnline(
  lastSeenAt: Date | null | undefined,
  now = new Date(),
  offlineAfterSeconds = agentOfflineAfterSeconds(),
) {
  if (!lastSeenAt) return false;
  const ageMs = now.getTime() - lastSeenAt.getTime();
  return ageMs >= 0 && ageMs <= offlineAfterSeconds * 1_000;
}

export function agentLastSeenLabel(lastSeenAt: Date | null | undefined, now = new Date()) {
  if (!lastSeenAt) return "Never seen";
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - lastSeenAt.getTime()) / 1_000));
  if (ageSeconds < 5) return "Seen just now";
  if (ageSeconds < 60) return `Seen ${ageSeconds}s ago`;
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `Seen ${ageMinutes}m ago`;
  return `Seen ${Math.floor(ageMinutes / 60)}h ago`;
}
