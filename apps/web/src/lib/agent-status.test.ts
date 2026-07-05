import assert from "node:assert/strict";
import test from "node:test";
import { agentLastSeenLabel, isAgentOnline } from "./agent-status.ts";

const now = new Date("2026-07-05T13:00:00.000Z");

test("fresh and boundary heartbeats are online", () => {
  assert.equal(isAgentOnline(new Date("2026-07-05T12:59:30.000Z"), now, 90), true);
  assert.equal(isAgentOnline(new Date("2026-07-05T12:58:30.000Z"), now, 90), true);
});

test("expired and missing heartbeats are offline", () => {
  assert.equal(isAgentOnline(new Date("2026-07-05T12:58:29.999Z"), now, 90), false);
  assert.equal(isAgentOnline(null, now, 90), false);
});

test("a new heartbeat recovers online status", () => {
  assert.equal(isAgentOnline(new Date("2026-07-05T12:55:00.000Z"), now, 90), false);
  assert.equal(isAgentOnline(new Date("2026-07-05T13:00:00.000Z"), now, 90), true);
});

test("last-seen labels expose useful heartbeat age", () => {
  assert.equal(agentLastSeenLabel(null, now), "Never seen");
  assert.equal(agentLastSeenLabel(new Date("2026-07-05T12:59:28.000Z"), now), "Seen 32s ago");
  assert.equal(agentLastSeenLabel(new Date("2026-07-05T12:57:00.000Z"), now), "Seen 3m ago");
});
