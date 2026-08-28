/**
 * SPEC §8's silent-ignore guard: omp's `autoload-skills` frontmatter field
 * silently ignores a name that resolves to nothing, so a typo or a shadowed
 * skill fails with no signal at all. omp exposes no skill-resolution API in
 * the declared runtime (`omp-runtime.d.ts`), so this resolves from the
 * filesystem the same way the `omp-plugins` provider would: read every
 * `foreman-*` agent's `autoloadSkills` frontmatter, then check each name
 * against this plugin's `skills/<name>/SKILL.md` and against the
 * higher-priority native locations that would shadow it first — project
 * `.omp/skills/<name>/` beats user `~/.omp/agent/skills/<name>/` beats the
 * plugin (SPEC §3.3).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SkillGuardProblem {
  agent: string;
  skill: string;
  reason: "missing" | "shadowed";
  /** Set only for "shadowed": the native path that wins over the plugin's copy. */
  shadowedBy?: string;
}

const AUTOLOAD_RE = /^autoloadSkills:\s*\[([^\]]*)\]\s*$/m;

function parseAutoloadSkills(frontmatter: string): string[] {
  const match = AUTOLOAD_RE.exec(frontmatter);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function frontmatterOf(agentFileContent: string): string {
  const parts = agentFileContent.split(/^---\s*$/m);
  return parts[1] ?? "";
}

function skillExistsAt(skillsRoot: string, skillName: string): boolean {
  return existsSync(join(skillsRoot, skillName, "SKILL.md"));
}

/**
 * Checks every `foreman-*` agent's autoloaded skills. Returns one problem
 * per skill that either resolves nowhere or resolves to a native location
 * that shadows the plugin's copy — either case is a silent-ignore trap the
 * operator must see.
 */
export function checkSkillAutoload(options: {
  pluginRoot: string;
  cwd: string;
  home?: string;
}): SkillGuardProblem[] {
  const home = options.home ?? homedir();
  const agentsDir = join(options.pluginRoot, "agents");
  const pluginSkillsRoot = join(options.pluginRoot, "skills");
  const projectSkillsRoot = join(options.cwd, ".omp", "skills");
  const userSkillsRoot = join(home, ".omp", "agent", "skills");

  const problems: SkillGuardProblem[] = [];
  if (!existsSync(agentsDir)) return problems;

  const agentFiles = readdirSync(agentsDir).filter((name) => name.startsWith("foreman-") && name.endsWith(".md"));
  for (const fileName of agentFiles) {
    const agentName = fileName.replace(/\.md$/, "");
    const content = readFileSync(join(agentsDir, fileName), "utf8");
    const skills = parseAutoloadSkills(frontmatterOf(content));

    for (const skillName of skills) {
      if (skillExistsAt(projectSkillsRoot, skillName)) {
        problems.push({
          agent: agentName,
          skill: skillName,
          reason: "shadowed",
          shadowedBy: join(projectSkillsRoot, skillName),
        });
        continue;
      }
      if (skillExistsAt(userSkillsRoot, skillName)) {
        problems.push({
          agent: agentName,
          skill: skillName,
          reason: "shadowed",
          shadowedBy: join(userSkillsRoot, skillName),
        });
        continue;
      }
      if (!skillExistsAt(pluginSkillsRoot, skillName)) {
        problems.push({ agent: agentName, skill: skillName, reason: "missing" });
      }
    }
  }

  return problems;
}

export function formatSkillGuardProblem(problem: SkillGuardProblem): string {
  if (problem.reason === "missing") {
    return `${problem.agent}: autoloaded skill "${problem.skill}" resolves to nothing (silently ignored by omp).`;
  }
  return `${problem.agent}: autoloaded skill "${problem.skill}" is shadowed by ${problem.shadowedBy ?? "a native location"}, naming both paths.`;
}
