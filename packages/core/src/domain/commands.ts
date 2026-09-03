/** Slash commands omp registers from `packages/omp-plugin/commands/*.md`, named `<plugin>:<file-stem>`. */
export const DISPATCH_COMMAND = {
  triage: "/foreman:triage",
  plan: "/foreman:plan",
  roadmap: "/foreman:roadmap",
  refine: "/foreman:refine",
  implement: "/foreman:implement",
  review: "/foreman:review",
} as const;

export type DispatchCommandKey = keyof typeof DISPATCH_COMMAND;
