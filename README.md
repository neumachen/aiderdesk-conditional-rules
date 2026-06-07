# aiderdesk-conditional-rules

AiderDesk extension that loads rule files **only when the current task is
working on files that match the rule's globs.** Cursor-style on-demand
rule selection for AiderDesk.

If you've ever wished AiderDesk would load your Go style rules **only**
when you're editing Go code, and your Docker rules **only** when you're
touching a `Dockerfile`, this is that.

## How it works

AiderDesk's native rule loader reads every `.md` file in
`~/.aider-desk/rules/` and `<project>/.aider-desk/rules/` into the system
prompt on every turn. This extension layers conditional loading on top
by handling **`.mdc` files** in the same directories (the native loader
ignores them).

Each `.mdc` file declares its activation condition via YAML frontmatter:

```yaml
---
description: Go coding conventions
globs:
  - '**/*.go'
  - '**/go.mod'
  - '**/go.sum'
alwaysApply: false
---
# Go Rule: Core Style
…body of the rule…
```

On every agent turn, the extension:

1. Scans `~/.aider-desk/rules/` and `<project>/.aider-desk/rules/` for
   `.mdc` files.
2. Parses each one's YAML frontmatter.
3. Asks AiderDesk for the **files currently in the task's context.**
4. Includes a rule when:
   - `alwaysApply: true`, **or**
   - at least one `globs:` entry matches at least one context file.
5. Returns the augmented rule list. AiderDesk's prompt manager reads
   each included rule from disk verbatim and injects it.

The decision is **file-glob-driven, not agent-decision-driven.** For a
polyglot task (Go + Dockerfile in context), Go and Docker rules both
load. For a Go-only task, only the Go rules load.

## Frontmatter schema

All fields optional.

| Field         | Type                 | Default | Behaviour                                                                                                                  |
| ------------- | -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `description` | string               | —       | Human-readable. Not used for matching; appears in the prompt so the agent sees a one-liner explaining why the rule loaded. |
| `globs`       | string \| string\[\] | —       | Patterns matched against context file paths. A single string is treated as comma-separated (`"**/*.go, **/go.mod"`).       |
| `alwaysApply` | boolean              | `false` | When `true`, the rule loads on every turn regardless of globs.                                                             |

| Frontmatter state                                   | Result                      |
| --------------------------------------------------- | --------------------------- |
| `alwaysApply: true`                                 | always include              |
| no frontmatter at all                               | include (defensive default) |
| `globs:` present, ≥ 1 glob matches ≥ 1 context file | include                     |
| `globs:` present, no glob matches                   | **exclude**                 |

## Glob matching

- Globs are matched against **two forms** of each context file path:
  project-relative and absolute. So `**/*.go` matches both `src/foo.go`
  and `/abs/path/src/foo.go`.
- Implementation uses [`picomatch`](https://github.com/micromatch/picomatch)
  with `{ dot: true }` so `.env`-style filenames work.
- **No glob negation in v0.1.0.** Patterns like `!**/*_test.go` are
  ignored. Use the body of the rule to handle exclusions.
- **No subdirectory recursion in v0.1.0.** Only top-level `.mdc` files
  in each rules directory are scanned.

## File layout

Put `.mdc` files alongside your `.md` rules:

```
~/.aider-desk/rules/
├── SECURITY-01-SECRETS.md          # always-on (native loader)
├── GIT-01-COMMIT-MESSAGES.md       # always-on (native loader)
├── GOLANG-01-STYLE.mdc             # globs: ["**/*.go"]
├── GOLANG-08-TESTING.mdc           # globs: ["**/*.go"]
├── DOCKER-01-HOST-ACCESS.mdc       # globs: ["**/Dockerfile*", …]
└── PYTHON-01-STYLE.mdc             # globs: ["**/*.py"]
```

The `.md` files keep their existing always-on behaviour. The `.mdc`
files are handled exclusively by this extension.

## Install

### One-off (current user)

```bash
npx @aiderdesk/extensions install https://github.com/neumachen/aiderdesk-conditional-rules \
  --directory ~/.aider-desk/extensions
```

Restart AiderDesk.

### Inside the shiki container image

Add the GitHub URL to `AIDER_DESK_EXTENSIONS_DEFAULT` in your
`private_dot_config/exact_shiki/shiki.Dockerfile`:

```dockerfile
ARG AIDER_DESK_EXTENSIONS_DEFAULT="…, \
    https://github.com/neumachen/aiderdesk-conditional-rules"
```

Then rebuild:

```bash
shiki --rebuild
```

Every new shiki session will have the extension active.

## Configuration

The extension creates `<extensionDir>/config.json` on first save. Schema:

```json
{
  "scanProjectRules": true,
  "scanGlobalRules": true,
  "extraRuleDirs": ""
}
```

- `scanProjectRules` — whether to scan `<project>/.aider-desk/rules/`. Default `true`.
- `scanGlobalRules` — whether to scan `~/.aider-desk/rules/`. Default `true`.
- `extraRuleDirs` — comma-separated additional directories to scan.
  Paths are absolute, `~`-expanded, or relative to the project dir.

There is no UI config component in v0.1.0; edit the JSON directly if you
need to tweak.

## What this does NOT do

- It does not change how `.md` files are loaded. Those remain always-on.
- It does not change content of any rule file. Frontmatter will appear
  in the prompt.
- It does not handle Cursor's `agent_requested` / `manual` modes. Only
  `alwaysApply` and `globs:` are honoured. (Future v0.2 candidate.)
- It does not de-duplicate rules with the same basename across global +
  project dirs. If you have `~/.aider-desk/rules/GOLANG-01.mdc` AND
  `<project>/.aider-desk/rules/GOLANG-01.mdc`, both will load. The
  project rule wins by virtue of appearing later in the list and getting
  the last word in the prompt.

## Status & roadmap

- **v0.1.0 (current draft):** core hook, `.mdc` scanning, frontmatter
  parsing, glob matching, three test suites, working stub implementation.
- **v0.2 (tentative):** glob negation, subdirectory recursion, config UI
  component, possibly augmenting the context match set with files
  explicitly named in the user's prompt.

## Development

```bash
nvm use
npm install

npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run format:check # prettier --check
npm test             # vitest run
npm run check        # all of the above
```

Node 22 (see `.nvmrc`).

## License

MIT. See [LICENSE](./LICENSE).

## Related projects

- [`neumachen/aiderdesk-codex-extension`](https://github.com/neumachen/aiderdesk-codex-extension) — sibling extension; same packaging conventions.
- [`hotovo/aider-desk`](https://github.com/hotovo/aider-desk) — the host application this extension plugs into.
- [Cursor rules docs](https://docs.cursor.com/context/rules) — the convention this extension implements.
