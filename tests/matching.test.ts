/**
 * Tests for glob matching semantics.
 *
 * If the cases below cannot all be satisfied with a single picomatch
 * configuration, the matcher should use a hybrid strategy (try the full
 * path first, then the basename) — the behavioural promises stay the
 * same.
 */
import { describe, expect, it } from 'vitest';
import picomatch from 'picomatch';

/**
 * Helper: return true iff any context path matches any glob.
 * Mirrors the logic the extension uses in `shouldInclude`.
 */
function matchAny(globs: string[], paths: string[]): boolean {
  const matchers = globs.map((g) => picomatch(g, { dot: true }));
  return paths.some((p) => matchers.some((m) => m(p)));
}

describe('glob matching — project-relative paths', () => {
  it('matches **/*.go against src/foo.go', () => {
    expect(matchAny(['**/*.go'], ['src/foo.go'])).toBe(true);
  });

  it('matches **/Dockerfile* against Dockerfile', () => {
    expect(matchAny(['**/Dockerfile*'], ['Dockerfile'])).toBe(true);
  });

  it('matches **/Dockerfile* against api/Dockerfile.prod', () => {
    expect(matchAny(['**/Dockerfile*'], ['api/Dockerfile.prod'])).toBe(true);
  });

  it('does not match **/*.go against src/foo.py', () => {
    expect(matchAny(['**/*.go'], ['src/foo.py'])).toBe(false);
  });

  it('matches with multiple globs, any-match wins', () => {
    expect(matchAny(['**/*.go', '**/Dockerfile*'], ['Dockerfile'])).toBe(true);
    expect(matchAny(['**/*.go', '**/Dockerfile*'], ['src/foo.go'])).toBe(true);
    expect(matchAny(['**/*.go', '**/Dockerfile*'], ['README.md'])).toBe(false);
  });

  it('matches with multiple context files, any-match wins', () => {
    expect(matchAny(['**/*.go'], ['README.md', 'src/foo.go'])).toBe(true);
  });
});

describe('glob matching — should be tolerant of absolute paths too', () => {
  // The extension normalises context paths to multiple forms (absolute
  // and project-relative) and feeds all of them to the matcher. So a
  // glob like `**/*.go` must match an absolute path too.
  it('matches **/*.go against /abs/path/src/foo.go', () => {
    expect(matchAny(['**/*.go'], ['/abs/path/src/foo.go'])).toBe(true);
  });
});
