/**
 * The single busy-indicator glyph used wherever the shell shows "an
 * operation is in flight" (control commands, agent dispatch). A pure
 * function of the runtime's wall-clock `tick`, so it never owns its own
 * timer — `TuiRuntime` is the only thing allowed to touch the clock.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function spinnerFrame(tick: number): string {
  const index = ((tick % FRAMES.length) + FRAMES.length) % FRAMES.length;
  return FRAMES[index] as string;
}
