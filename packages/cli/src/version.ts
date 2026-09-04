/**
 * `foreman --version` — package version plus the checkout's short git SHA, so
 * a bug report can name exactly which build produced it. Never throws: a
 * broken or absent checkout must still print a version line, not crash the
 * one command an operator reaches for to sanity-check the install.
 */

import pkg from "../package.json" with { type: "json" };
import { findCheckoutRoot, looksLikeForemanRoot } from "./checkout.ts";
import { processRunner, type Runner } from "./exec.ts";

/** Renders `foreman --version`'s output, given a `Runner` to shell `git rev-parse` through (test seam; defaults to the real process runner). */
export async function renderVersion(checkoutPath: string | null, runner: Runner = processRunner): Promise<string> {
  const version = pkg.version;
  const checkoutRoot = checkoutPath
    ? looksLikeForemanRoot(checkoutPath)
      ? checkoutPath
      : null
    : findCheckoutRootOrNull();
  if (checkoutRoot === null) {
    return `foreman ${version} (unknown revision)\n`;
  }

  try {
    const { code, stdout } = await runner.capture("git", ["-C", checkoutRoot, "rev-parse", "--short", "HEAD"]);
    const sha = stdout.trim();
    if (code !== 0 || sha.length === 0) return `foreman ${version} (unknown revision)\n`;
    return `foreman ${version} (${sha})\ncheckout: ${checkoutRoot}\n`;
  } catch {
    return `foreman ${version} (unknown revision)\n`;
  }
}

/** `findCheckoutRoot` throws `CheckoutNotFoundError` when no checkout is found; `--version` treats that as "unknown revision", not a crash. */
function findCheckoutRootOrNull(): string | null {
  try {
    return findCheckoutRoot();
  } catch {
    return null;
  }
}
