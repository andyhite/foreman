/**
 * A stage's shared orchestrator is mid-turn (SPEC §17.4).
 *
 * `herdr agent prompt` accepts a submission while the target is `working` — it
 * does not track turns — and omp delivers that submission as a queued user
 * message that interrupts the turn's in-flight tool calls. For an orchestrator
 * whose turn *is* a `task` call carrying a whole batch, that interruption would
 * abandon the batch. So the dispatcher refuses to prompt a working agent and
 * the worker defers to its next tick instead, which is a routine skip rather
 * than a failure: nothing was recorded in flight and nothing needs unwinding.
 */

export class OrchestratorBusyError extends Error {
  readonly agentName: string;

  constructor(agentName: string, message: string) {
    super(message);
    this.name = "OrchestratorBusyError";
    this.agentName = agentName;
  }
}

export function isOrchestratorBusy(error: unknown): error is OrchestratorBusyError {
  return error instanceof OrchestratorBusyError;
}
