/**
 * Validation for the keyed dependency graphs agents emit (SPEC §6).
 *
 * An agent that proposes several issues or projects at once has to express
 * the order they ship in, but none of them exist in Linear yet — there is no
 * identifier to point at. So each entry carries a `key` local to the result
 * and a `blockedBy` list of sibling keys, and the extension resolves those
 * into native relations after creating the entries.
 *
 * JSON Schema can express "array of strings" and nothing about whether those
 * strings resolve, repeat, or close a cycle, so those three checks live here
 * and run from `parse.ts` alongside the envelope's other cross-field
 * invariants. A cyclic proposal is rejected rather than partially applied:
 * every entry in a cycle would gate on another, so none could ever be picked
 * up, and the loop would sit on a permanently unbuildable slate.
 */

export interface DependencyNode {
  key: string;
  blockedBy: readonly string[];
}

/**
 * Returns one problem string per violation, JSON-pointer prefixed with
 * `pointerPrefix` (e.g. `/result/proposedIssues`). Empty means valid.
 */
export function validateDependencyKeys(
  nodes: readonly DependencyNode[],
  pointerPrefix: string,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    if (seen.has(node.key)) {
      problems.push(`${pointerPrefix}/${index}/key: duplicate key "${node.key}"`);
      continue;
    }
    seen.add(node.key);
  }

  for (const [index, node] of nodes.entries()) {
    for (const [refIndex, ref] of node.blockedBy.entries()) {
      const pointer = `${pointerPrefix}/${index}/blockedBy/${refIndex}`;
      if (ref === node.key) {
        problems.push(`${pointer}: "${ref}" blocks itself`);
      } else if (!seen.has(ref)) {
        problems.push(`${pointer}: "${ref}" matches no key in this result`);
      }
    }
  }

  // Only walk for cycles once every edge is known to resolve; a dangling ref
  // would otherwise be reported twice, once as unresolved and again as a
  // phantom cycle.
  if (problems.length === 0) {
    const cycle = findCycle(nodes);
    if (cycle) {
      problems.push(`${pointerPrefix}: dependency cycle ${cycle.join(" -> ")}`);
    }
  }

  return problems;
}

/**
 * Iterative depth-first search returning the first cycle found as a key path
 * that starts and ends on the same key, so the message names the loop rather
 * than just asserting one exists. Iterative rather than recursive because the
 * input is agent-supplied and its depth is not bounded by anything Foreman
 * controls.
 */
function findCycle(nodes: readonly DependencyNode[]): string[] | null {
  const edges = new Map<string, readonly string[]>();
  for (const node of nodes) edges.set(node.key, node.blockedBy);

  const settled = new Set<string>();
  for (const root of edges.keys()) {
    if (settled.has(root)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    const stack: Array<{ key: string; next: number }> = [{ key: root, next: 0 }];
    path.push(root);
    onPath.add(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const children = edges.get(frame.key) ?? [];
      if (frame.next >= children.length) {
        settled.add(frame.key);
        onPath.delete(frame.key);
        path.pop();
        stack.pop();
        continue;
      }
      const child = children[frame.next];
      frame.next += 1;
      if (child === undefined || settled.has(child)) continue;
      if (onPath.has(child)) {
        return [...path.slice(path.indexOf(child)), child];
      }
      path.push(child);
      onPath.add(child);
      stack.push({ key: child, next: 0 });
    }
  }
  return null;
}
