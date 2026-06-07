/**
 * End-to-end-ish tests for the onRuleFilesRetrieved hook.
 *
 * Uses on-the-fly fixture rule files written to a tmp directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ConditionalRulesExtension from '../index.js';

import type { ContextFile, ExtensionContext, TaskContext } from '@aiderdesk/extensions';

/**
 * Minimal in-memory implementations of ExtensionContext / TaskContext.
 */
function makeContext(projectDir: string, contextFiles: ContextFile[]): ExtensionContext {
  const taskContext: Partial<TaskContext> = {
    getContextFiles: () => Promise.resolve(contextFiles),
  };
  const ctx: Partial<ExtensionContext> = {
    log: vi.fn(),
    getProjectDir: () => projectDir,
    getTaskContext: () => taskContext as TaskContext,
  };
  return ctx as ExtensionContext;
}

describe('onRuleFilesRetrieved hook', () => {
  let projectDir: string;
  let rulesDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'adcr-'));
    rulesDir = join(projectDir, '.aider-desk', 'rules');
    mkdirSync(rulesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeRule(name: string, frontmatter: string, body = 'rule body'): void {
    writeFileSync(
      join(rulesDir, name),
      frontmatter ? `---\n${frontmatter}\n---\n${body}\n` : `${body}\n`,
      'utf-8',
    );
  }

  it('includes alwaysApply rules even with no context files', async () => {
    writeRule('SECURITY.mdc', 'alwaysApply: true');

    const ext = new ConditionalRulesExtension();
    const ctx = makeContext(projectDir, []);
    const result = await ext.onRuleFilesRetrieved({ files: [] }, ctx);

    expect(result).toBeDefined();
    expect(result?.files).toHaveLength(1);
    expect(result?.files?.[0]?.path).toBe('.aider-desk/rules/SECURITY.mdc');
    expect(result?.files?.[0]?.source).toBe('project-rule');
  });

  it('includes glob-matching rules when context has a matching file', async () => {
    writeRule('GOLANG.mdc', 'globs:\n  - "**/*.go"');

    const ext = new ConditionalRulesExtension();
    const ctx = makeContext(projectDir, [{ path: 'src/main.go', readOnly: false }]);
    const result = await ext.onRuleFilesRetrieved({ files: [] }, ctx);

    expect(result?.files).toHaveLength(1);
    expect(result?.files?.[0]?.path).toBe('.aider-desk/rules/GOLANG.mdc');
  });

  it('excludes glob-only rules when context has no matching file', async () => {
    writeRule('GOLANG.mdc', 'globs:\n  - "**/*.go"');

    const ext = new ConditionalRulesExtension();
    const ctx = makeContext(projectDir, [{ path: 'README.md', readOnly: false }]);
    const result = await ext.onRuleFilesRetrieved({ files: [] }, ctx);

    expect(result).toBeUndefined();
  });

  it('includes multiple matching rules in a polyglot context', async () => {
    writeRule('GOLANG.mdc', 'globs:\n  - "**/*.go"');
    writeRule('DOCKER.mdc', 'globs:\n  - "**/Dockerfile*"');
    writeRule('PYTHON.mdc', 'globs:\n  - "**/*.py"');

    const ext = new ConditionalRulesExtension();
    const ctx = makeContext(projectDir, [
      { path: 'src/main.go', readOnly: false },
      { path: 'Dockerfile', readOnly: false },
    ]);
    const result = await ext.onRuleFilesRetrieved({ files: [] }, ctx);

    expect(result?.files).toHaveLength(2);
    const paths = result?.files?.map((f) => f.path).sort() ?? [];
    expect(paths).toEqual(['.aider-desk/rules/DOCKER.mdc', '.aider-desk/rules/GOLANG.mdc']);
  });

  it('preserves the existing files list and appends matches', async () => {
    writeRule('GOLANG.mdc', 'globs:\n  - "**/*.go"');

    const ext = new ConditionalRulesExtension();
    const ctx = makeContext(projectDir, [{ path: 'src/main.go', readOnly: false }]);
    const existing: ContextFile[] = [{ path: '~/.aider-desk/rules/SECURITY.md', readOnly: true, source: 'global-rule' }];
    const result = await ext.onRuleFilesRetrieved({ files: existing }, ctx);

    expect(result?.files).toHaveLength(2);
    expect(result?.files?.[0]?.path).toBe('~/.aider-desk/rules/SECURITY.md');
    expect(result?.files?.[1]?.path).toBe('.aider-desk/rules/GOLANG.mdc');
  });

  it('treats a rule with no frontmatter as always-on (defensive default)', async () => {
    writeRule('PLAIN.mdc', '');

    const ext = new ConditionalRulesExtension();
    const ctx = makeContext(projectDir, []);
    const result = await ext.onRuleFilesRetrieved({ files: [] }, ctx);

    expect(result?.files).toHaveLength(1);
    expect(result?.files?.[0]?.path).toBe('.aider-desk/rules/PLAIN.mdc');
  });

  it('ignores .md files (those are loaded by the native loader)', async () => {
    // Drop a .md file — extension should NOT pick it up.
    writeFileSync(join(rulesDir, 'NATIVE.md'), 'native rule\n', 'utf-8');

    const ext = new ConditionalRulesExtension();
    const ctx = makeContext(projectDir, []);
    const result = await ext.onRuleFilesRetrieved({ files: [] }, ctx);

    // No .mdc files at all → undefined (no mutation).
    expect(result).toBeUndefined();
  });
});
