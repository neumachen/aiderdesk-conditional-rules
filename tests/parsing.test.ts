/**
 * Tests for YAML frontmatter parsing.
 *
 * These tests pin gray-matter's behaviour for the three frontmatter
 * fields the extension cares about (`description`, `globs`,
 * `alwaysApply`) and the failure modes the production code must
 * handle.
 */
import { describe, expect, it } from 'vitest';
import matter from 'gray-matter';

describe('frontmatter parsing', () => {
  it('extracts globs as string array', () => {
    const src = `---\nglobs:\n  - "**/*.go"\n  - "**/go.mod"\n---\nbody`;
    const out = matter(src);
    expect(out.data.globs).toEqual(['**/*.go', '**/go.mod']);
  });

  it('extracts globs as comma-separated string', () => {
    const src = `---\nglobs: "**/*.go, **/go.mod"\n---\nbody`;
    const out = matter(src);
    expect(out.data.globs).toBe('**/*.go, **/go.mod');
  });

  it('extracts alwaysApply: true', () => {
    const src = `---\nalwaysApply: true\n---\nbody`;
    const out = matter(src);
    expect(out.data.alwaysApply).toBe(true);
  });

  it('returns empty data for files with no frontmatter', () => {
    const out = matter('just a plain rule body');
    expect(out.data).toEqual({});
    expect(out.content.trim()).toBe('just a plain rule body');
  });

  it('throws on malformed frontmatter', () => {
    // gray-matter raises on invalid YAML between the --- fences.
    // Production code wraps `matter()` in try/catch, logs a warning,
    // and treats the rule as always-on (or skips it).
    expect(() => matter('---\n: not valid yaml :\n---\nbody')).toThrow();
  });
});
