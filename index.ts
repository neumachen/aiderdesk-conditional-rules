/**
 * AiderDesk Conditional Rules Extension
 *
 * Filters and injects rule files based on YAML frontmatter (`globs:`,
 * `alwaysApply:`) matched against the current task's context files.
 *
 * Mirrors the Cursor `.cursor/rules/*.mdc` convention so that:
 *   - `.md`  files in `~/.aider-desk/rules/` and `<project>/.aider-desk/rules/`
 *            are loaded by AiderDesk's native rule loader (always-on).
 *   - `.mdc` files in the same directories are invisible to the native loader,
 *            and are added by this extension ONLY when their `globs:`
 *            front-matter matches at least one file currently in the task's
 *            context (or when `alwaysApply: true`).
 *
 * Hook: `onRuleFilesRetrieved` — fires once per agent turn after the native
 * loader has built the initial rule list. We mutate that list.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep, posix } from 'node:path';

import matter from 'gray-matter';
import picomatch from 'picomatch';

import type {
  ContextFile,
  Extension,
  ExtensionContext,
  RuleFilesRetrievedEvent,
} from '@aiderdesk/extensions';

// ── Types ──────────────────────────────────────────────────────────────

interface ConditionalRulesConfig {
  /**
   * Whether to also scan project-local `.aider-desk/rules/` for `.mdc` files.
   * Default: true.
   */
  scanProjectRules: boolean;

  /**
   * Whether to also scan global `~/.aider-desk/rules/` for `.mdc` files.
   * Default: true.
   */
  scanGlobalRules: boolean;

  /**
   * Comma-separated list of additional directories to scan, relative to the
   * project dir or absolute. Default: empty.
   */
  extraRuleDirs: string;
}

const DEFAULT_CONFIG: ConditionalRulesConfig = {
  scanProjectRules: true,
  scanGlobalRules: true,
  extraRuleDirs: '',
};

interface RuleFrontmatter {
  description?: string;
  globs?: string | string[];
  alwaysApply?: boolean;
}

interface ParsedRule {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Display path passed back to AiderDesk (either `~/...` or project-relative). */
  displayPath: string;
  /** Whether this is a global (`~/...`) rule or a project-local rule. */
  source: 'global-rule' | 'project-rule';
  /** Parsed YAML frontmatter (may be empty). */
  frontmatter: RuleFrontmatter;
  /** mtime in ms for cache invalidation. */
  mtimeMs: number;
}

// ── Cache ──────────────────────────────────────────────────────────────

/**
 * Cache of parsed rule files keyed by absolute path. Invalidated when the
 * file's mtime changes. The cache persists for the lifetime of the
 * extension process (AiderDesk session), which is fine — rule files do
 * not change mid-session in any realistic workflow.
 */
const parseCache = new Map<string, ParsedRule>();

// ── Extension ──────────────────────────────────────────────────────────

export default class ConditionalRulesExtension implements Extension {
  static metadata = {
    name: 'Conditional Rules',
    version: '0.1.0',
    description:
      'Filters rule files based on YAML frontmatter (globs:, alwaysApply:) matched against the current task context. Cursor-style on-demand rule selection.',
    author: 'Kareem Hepburn',
    iconUrl: '',
    capabilities: ['context'],
  };

  private readonly configPath: string;

  constructor() {
    this.configPath = join(__dirname, 'config.json');
  }

  async onLoad(context: ExtensionContext): Promise<void> {
    context.log('Conditional Rules extension loaded', 'info');
  }

  // ── Config UI ────────────────────────────────────────────────────────

  async getConfigData(): Promise<ConditionalRulesConfig> {
    try {
      if (existsSync(this.configPath)) {
        const raw = readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<ConditionalRulesConfig>;
        return { ...DEFAULT_CONFIG, ...parsed };
      }
    } catch {
      // Fall through to defaults on any parse / IO error.
    }
    return { ...DEFAULT_CONFIG };
  }

  async saveConfigData(configData: unknown): Promise<unknown> {
    const config = configData as Partial<ConditionalRulesConfig>;
    const merged = { ...DEFAULT_CONFIG, ...config };
    writeFileSync(this.configPath, JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
  }

  // ── Main hook ────────────────────────────────────────────────────────

  async onRuleFilesRetrieved(
    event: RuleFilesRetrievedEvent,
    context: ExtensionContext,
  ): Promise<void | Partial<RuleFilesRetrievedEvent>> {
    const projectDir = context.getProjectDir();
    if (!projectDir) {
      // No project scope — nothing to glob against. Pass through.
      return undefined;
    }

    const taskContext = context.getTaskContext();
    if (!taskContext) {
      // No task scope — same.
      return undefined;
    }

    const config = await this.getConfigData();

    // 1. Discover all `.mdc` rule files in the configured directories.
    const candidates = this.discoverCandidates(projectDir, config, context);
    if (candidates.length === 0) {
      return undefined;
    }

    // 2. Get the current task's context files for glob matching.
    const contextFiles = await taskContext.getContextFiles();
    const contextPaths = this.normalizeContextPaths(contextFiles, projectDir);

    // 3. Filter candidates: keep alwaysApply or any-glob-matches.
    const matched = candidates.filter((rule) => this.shouldInclude(rule, contextPaths, context));

    if (matched.length === 0) {
      context.log('No conditional rules matched current context', 'debug');
      return undefined;
    }

    context.log(
      `Conditional rules matched (${matched.length}): ${matched.map((r) => r.displayPath).join(', ')}`,
      'debug',
    );

    // 4. Append matched rules to the existing files list.
    const added: ContextFile[] = matched.map((rule) => ({
      path: rule.displayPath,
      readOnly: true,
      source: rule.source,
    }));

    return {
      files: [...event.files, ...added],
    };
  }

  // ── Discovery ────────────────────────────────────────────────────────

  private discoverCandidates(
    projectDir: string,
    config: ConditionalRulesConfig,
    context: ExtensionContext,
  ): ParsedRule[] {
    const home = homedir();
    const dirs: Array<{ absDir: string; source: 'global-rule' | 'project-rule' }> = [];

    if (config.scanGlobalRules) {
      dirs.push({ absDir: join(home, '.aider-desk', 'rules'), source: 'global-rule' });
    }
    if (config.scanProjectRules) {
      dirs.push({ absDir: join(projectDir, '.aider-desk', 'rules'), source: 'project-rule' });
    }
    if (config.extraRuleDirs) {
      for (const raw of config.extraRuleDirs.split(',').map((s) => s.trim()).filter(Boolean)) {
        const abs = raw.startsWith('/') || raw.startsWith('~') ? raw.replace(/^~/, home) : join(projectDir, raw);
        // Heuristic: treat extra dirs under $HOME as global, otherwise project.
        const source: 'global-rule' | 'project-rule' = abs.startsWith(home + sep) ? 'global-rule' : 'project-rule';
        dirs.push({ absDir: abs, source });
      }
    }

    const rules: ParsedRule[] = [];
    for (const { absDir, source } of dirs) {
      if (!existsSync(absDir)) continue;
      try {
        const stat = statSync(absDir);
        if (!stat.isDirectory()) continue;
        for (const entry of readdirSync(absDir)) {
          if (!entry.endsWith('.mdc')) continue;
          const abs = join(absDir, entry);
          const parsed = this.parseRuleCached(abs, source, projectDir, context);
          if (parsed) rules.push(parsed);
        }
      } catch (err) {
        context.log(
          `Error scanning rules directory ${absDir}: ${err instanceof Error ? err.message : String(err)}`,
          'warn',
        );
      }
    }
    return rules;
  }

  // ── Parsing (cached) ─────────────────────────────────────────────────

  private parseRuleCached(
    absolutePath: string,
    source: 'global-rule' | 'project-rule',
    projectDir: string,
    context: ExtensionContext,
  ): ParsedRule | null {
    try {
      const stat = statSync(absolutePath);
      const cached = parseCache.get(absolutePath);
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

      const raw = readFileSync(absolutePath, 'utf-8');
      const parsed = matter(raw);
      const frontmatter = (parsed.data ?? {}) as RuleFrontmatter;

      const displayPath = this.toDisplayPath(absolutePath, source, projectDir);

      const rule: ParsedRule = {
        absolutePath,
        displayPath,
        source,
        frontmatter,
        mtimeMs: stat.mtimeMs,
      };
      parseCache.set(absolutePath, rule);
      return rule;
    } catch (err) {
      context.log(
        `Error parsing rule ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`,
        'warn',
      );
      return null;
    }
  }

  /**
   * Convert an absolute path to the display path AiderDesk expects:
   *   - global rules: `~/.aider-desk/rules/foo.mdc`
   *   - project rules: `.aider-desk/rules/foo.mdc` (relative to projectDir)
   */
  private toDisplayPath(
    absolutePath: string,
    source: 'global-rule' | 'project-rule',
    projectDir: string,
  ): string {
    const home = homedir();
    if (source === 'global-rule' && absolutePath.startsWith(home + sep)) {
      // Posix-style path inside the ~ prefix — matches the upstream loader's format.
      return posix.join('~', relative(home, absolutePath).split(sep).join('/'));
    }
    if (absolutePath.startsWith(projectDir + sep)) {
      return relative(projectDir, absolutePath).split(sep).join('/');
    }
    return absolutePath;
  }

  // ── Matching ─────────────────────────────────────────────────────────

  private normalizeContextPaths(contextFiles: ContextFile[], projectDir: string): string[] {
    const home = homedir();
    const out: string[] = [];
    for (const f of contextFiles) {
      if (!f.path) continue;
      let p = f.path;
      if (p.startsWith('~/')) p = join(home, p.slice(2));
      // Both absolute and project-relative forms are useful for matching.
      // We feed picomatch posix-style paths.
      const posixAbs = p.startsWith('/') ? p.split(sep).join('/') : posix.join(projectDir.split(sep).join('/'), p.split(sep).join('/'));
      const posixRel = p.startsWith('/')
        ? relative(projectDir, p).split(sep).join('/')
        : p.split(sep).join('/');
      out.push(posixAbs);
      if (posixRel && !posixRel.startsWith('..')) out.push(posixRel);
    }
    return out;
  }

  private shouldInclude(
    rule: ParsedRule,
    contextPaths: string[],
    context: ExtensionContext,
  ): boolean {
    const { frontmatter, displayPath } = rule;

    if (frontmatter.alwaysApply === true) return true;

    const globs = this.normalizeGlobs(frontmatter.globs);
    if (globs.length === 0) {
      // No globs and not alwaysApply: defensive default = include.
      // Rationale: a rule file with no frontmatter at all should still load,
      // so a user can drop a plain `.mdc` in and have it behave like a `.md`.
      context.log(`Rule ${displayPath} has no globs and no alwaysApply; treating as always-on`, 'debug');
      return true;
    }

    const matchers = globs.map((g) => picomatch(g, { dot: true, contains: false, basename: true }));
    return contextPaths.some((p) => matchers.some((m) => m(p)));
  }

  private normalizeGlobs(input: RuleFrontmatter['globs']): string[] {
    if (!input) return [];
    if (typeof input === 'string') {
      // Allow comma-separated form: `globs: "**/*.go, **/go.mod"`.
      return input.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (Array.isArray(input)) {
      return input.map((s) => String(s).trim()).filter(Boolean);
    }
    return [];
  }
}
