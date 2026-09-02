/**
 * `omp plugin list --json` payloads, captured from omp 18.1.4 rather than
 * written by hand.
 *
 * Hand-written samples are what let the scope parse regress: every invented
 * fixture spelled the scope as a bare `project` column, so a parser that
 * only recognized a bare column passed its tests and then read every real
 * install as absent. Anything here that was not captured says so.
 */

/** The `npm` half of the payload, present regardless of any marketplace install. */
const NPM_SECTION = `  "npm": [
    {
      "name": "@foreman/omp-plugin",
      "version": "0.1.0",
      "path": "/Users/dev/.omp/plugins/node_modules/@foreman/omp-plugin",
      "manifest": {
        "name": "foreman",
        "description": "Agile SDLC workflow over Linear",
        "extensions": [
          "./dist/extension.js"
        ],
        "version": "0.1.0"
      },
      "enabledFeatures": null,
      "enabled": true
    }
  ]`;

function marketplaceElement(scope: "project" | "user", shadowed: boolean): string {
  return `    {
      "id": "foreman@foreman",
      "scope": "${scope}",${shadowed ? `\n      "shadowedBy": "project",` : ""}
      "entries": [
        {
          "scope": "${scope}",
          "installPath": "/Users/dev/.omp/plugins/cache/plugins/foreman___foreman___0.1.0",
          "version": "0.1.0",
          "installedAt": "2026-09-02T20:02:30.815Z",
          "lastUpdated": "2026-09-02T20:02:30.815Z"
        }
      ]
    }`;
}

/**
 * omp lists the project registry and the user registry separately and pushes
 * one element per (plugin id, registry) pair, so a plugin installed at both
 * scopes appears twice under one id and the user element carries
 * `shadowedBy: "project"`. Only the single-scope shapes were captured live;
 * the both-scopes shape is assembled from those two, matching omp's
 * `listInstalledPlugins`.
 */
export function ompPluginListJson(scopes: Array<"project" | "user">): string {
  const elements = scopes.map((scope) => marketplaceElement(scope, scope === "user" && scopes.includes("project")));
  return `{
${NPM_SECTION},
  "marketplace": [${elements.length > 0 ? `\n${elements.join(",\n")}\n  ` : ""}]
}
`;
}

/**
 * The human table, captured from the same repo, kept so the parser can be
 * asserted to *reject* it. omp renders the scope parenthesized after the
 * version, which is why a whitespace-column parse of this text finds no
 * scope at all and reports a healthy install as missing.
 */
export const OMP_PLUGIN_LIST_TABLE = `npm Plugins:

● @foreman/omp-plugin@0.1.0
  Agile SDLC workflow over Linear

Marketplace Plugins:

  foreman@foreman (0.1.0) (project)
`;
