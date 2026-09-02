/**
 * Validates every GraphQL document in `src/linear/queries.ts` against Linear's
 * own schema, fetched by introspection.
 *
 * This exists because a fabricated field name is invisible to the test suite:
 * a fake answers whatever shape it likes without ever looking at the query
 * text, so `Team.workflowStates` - a field Linear does not have - passed 618
 * tests while failing every real call, and the `content { body }` fallback
 * documents could never have validated at all (docs/VERIFIED.md).
 *
 * Not part of `bun run check`: it needs a live Linear credential, and `check`
 * has to run offline. Run it after touching `queries.ts`:
 *
 *   bun run schema:linear
 *
 * Nothing is executed - `validate` is static analysis against the schema - so
 * mutations are checked as safely as queries.
 */

import { buildClientSchema, getIntrospectionQuery, parse, validate, type IntrospectionQuery } from "graphql";
import { loadGlobalConfig, resolveLinearApiKey } from "../src/index.ts";
import * as documents from "../src/linear/queries.ts";

const { config } = loadGlobalConfig();
const response = await fetch(config.linear.endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: resolveLinearApiKey(config) },
  body: JSON.stringify({ query: getIntrospectionQuery() }),
});
const body = (await response.json()) as { data?: IntrospectionQuery; errors?: unknown };
if (!body.data) {
  console.error(`introspection failed (HTTP ${response.status}): ${JSON.stringify(body.errors)}`);
  process.exit(1);
}
const schema = buildClientSchema(body.data);

/**
 * `queries.ts` also exports field-selection fragments (`issueQueryFields`),
 * which are not standalone documents. An operation is what this validates.
 */
function operations(): Array<{ name: string; text: string }> {
  const found: Array<{ name: string; text: string }> = [];
  for (const [name, value] of Object.entries(documents)) {
    const texts: Array<{ name: string; text: string }> =
      typeof value === "string"
        ? [{ name, text: value }]
        : typeof value === "function"
          ? [
              { name: `${name}(false)`, text: value(false) },
              { name: `${name}(true)`, text: value(true) },
            ]
          : [];
    for (const candidate of texts) {
      if (/^\s*(query|mutation|subscription)\b/.test(candidate.text)) found.push(candidate);
    }
  }
  return found;
}

let invalid = 0;
const checked = operations();
for (const document of checked) {
  const errors = validate(schema, parse(document.text));
  if (errors.length === 0) continue;
  invalid += 1;
  console.error(`INVALID ${document.name}`);
  for (const error of errors) console.error(`        ${error.message}`);
}

if (invalid > 0) {
  console.error(`\n${invalid} of ${checked.length} documents are invalid against Linear's schema`);
  process.exit(1);
}
console.log(`linear schema OK: ${checked.length} documents validate against the live schema`);
