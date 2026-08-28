#!/usr/bin/env bun
/**
 * `[[events]]` handler (SPEC §17.4): a push channel for herdr events. Two
 * jobs, both read-only —
 *
 * - **Refresh**: on agent state change, push updated sidebar tokens so panes
 *   showing stale terminal state catch up without the operator manually
 *   refreshing.
 * - **Anomaly alarm**: when an agent enters herdr `blocked`, per SPEC §17.3
 *   that means a Foreman bug — the design says agents never hit an approval
 *   or question UI — not a normal queue entry. This reports it as loudly as
 *   herdr's plugin surface allows (stderr plus a pane metadata token); it
 *   never writes Linear or touches routing, since herdr agent state is never
 *   a routing input (SPEC §17.3, §19).
 *
 * `HERDR_PLUGIN_EVENT` names the event; `HERDR_PLUGIN_EVENT_JSON` carries its
 * payload. Both are set by the herdr runtime for every `[[events]]` command
 * invocation.
 */

import { defaultRunCommand } from "./actions.ts";

interface AgentStateChangedPayload {
  agent?: { name?: string; status?: string; pane_id?: string };
}

function parseEventPayload(raw: string | undefined): AgentStateChangedPayload {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as AgentStateChangedPayload;
  } catch {
    return {};
  }
}

let anomalySeq = 0;

/**
 * Reports the anomaly via a pane metadata token, not `--state-label` — that
 * flag only accepts the fixed status set (`idle working blocked done
 * unknown`), so an arbitrary message cannot ride there. `--token
 * foreman_anomaly=<msg>` is the arbitrary NAME=VALUE channel (rendered as
 * `$foreman_anomaly` in sidebar rows, 80-char cap) — `--state-label
 * blocked=<msg>` also rides along so the status row itself reflects the
 * anomaly. `--seq` is monotonic per process so a stale report never
 * clobbers a fresher one.
 */
async function reportAnomaly(herdrBin: string, paneId: string, message: string): Promise<void> {
  anomalySeq += 1;
  const truncated = message.slice(0, 80);
  await defaultRunCommand(herdrBin, [
    "pane",
    "report-metadata",
    paneId,
    "--source",
    "foreman",
    "--seq",
    String(anomalySeq),
    "--token",
    `foreman_anomaly=${truncated}`,
    "--state-label",
    `blocked=${truncated}`,
    "--ttl-ms",
    "600000",
  ]);
}

const VALID_STATUS_LABELS: Record<string, true> = { idle: true, working: true, blocked: true, done: true, unknown: true };

/**
 * Routine refresh: pushes the agent's own status as `--state-label`, which
 * only accepts the fixed set `idle working blocked done unknown` — anything
 * outside that set is dropped rather than sent, since herdr would otherwise
 * reject the whole call.
 */
async function reportStatusRefresh(herdrBin: string, paneId: string, status: string): Promise<void> {
  if (!VALID_STATUS_LABELS[status]) return;
  anomalySeq += 1;
  await defaultRunCommand(herdrBin, [
    "pane",
    "report-metadata",
    paneId,
    "--source",
    "foreman",
    "--seq",
    String(anomalySeq),
    "--state-label",
    `${status}=refreshed`,
    "--ttl-ms",
    "600000",
  ]);
}

export async function runEventHandler(env: Record<string, string | undefined> = process.env): Promise<void> {
  const herdrBin = env.HERDR_BIN_PATH ?? "herdr";
  const eventName = env.HERDR_PLUGIN_EVENT ?? "";
  const payload = parseEventPayload(env.HERDR_PLUGIN_EVENT_JSON);
  const agent = payload.agent;

  if (!agent || eventName.length === 0) return;

  if (agent.status === "blocked" && agent.pane_id) {
    const message = `${agent.name ?? "unknown"} entered herdr blocked — recognized approval/question UI, ` +
      "which per SPEC §17.3 means a Foreman bug, not a decision queue.";
    // biome-ignore lint: deliberately loud — this is an anomaly report, not routine logging.
    console.error(`[foreman] ${message}`);
    await reportAnomaly(herdrBin, agent.pane_id, message);
    return;
  }

  if (agent.pane_id) {
    await reportStatusRefresh(herdrBin, agent.pane_id, agent.status ?? "unknown");
  }
}

if (import.meta.main) {
  await runEventHandler();
}
