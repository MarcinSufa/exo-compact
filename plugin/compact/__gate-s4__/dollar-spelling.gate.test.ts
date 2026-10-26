import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * Round 11: the real Claude Code 2.1.280 hook compiler refuses to load either plugin, quoted
 * verbatim from the debug log run by the maintainer against `e66f9f03` (CONTRACT.md's Layout
 * section has the full text):
 *
 * ```
 * [ERROR] hooks module exo-compact@inline failed to load: exo-compact:
 * .../proxy/hooks/compact/compact.ts, compiled line 21 `if (!await isCaptureEnabled($))`: $ is
 * passed to "isCaptureEnabled", imported from "./host/capture-flag.js": $ is followed only into a
 * function declared in this same file, never across an import; $ is always spelled
 * $.noun.event(...) at the call site, on is always on("<event>", hook), and next.to always
 * next.to(e, "<tier>")
 * ```
 *
 * The compiler reports only the first violation per module and stops, so the brief names two more
 * it would hit next in `compact.ts` (`makeFsCaptureStore($.fs, ...)`, twice) and one in
 * `trigger.ts` (`currentHost = $`, then `currentHost?.session.usage()`/`.compact()`). This gate
 * parses both entry files with the TypeScript compiler API (available as the `typescript`
 * dependency this repo already carries for `tsc`) and enforces the compiler's own stated rule
 * directly, so a future edit that reintroduces any of these shapes fails a fast unit test instead
 * of only being caught the next time the maintainer runs a real, expensive live probe.
 *
 * **Chosen shape, more conservative than strictly required (documented per the brief's own
 * "Uncertain" note in CONTRACT.md's round 11 section):** the compiler's rule 1 says `$` may be
 * passed into a function declared in the same file (just never into an import). This gate does
 * not carve out that exception: it flags `$` used as a bare identifier ANYWHERE other than the
 * hook parameter's own declaration or as the innermost receiver of a two-level `$.noun.event(...)`
 * call chain, regardless of which function it would otherwise be passed into. The fix in
 * `compact.ts`/`trigger.ts` never needs the same-file exception at all (every closure is built
 * inline, at the call site, with `$` spelled directly inside it), so this stricter check costs
 * nothing today and is simpler to state and verify than reproducing the compiler's own scoping
 * analysis of "declared in this same file" from scratch.
 */

interface DollarViolation {
  line: number;
  detail: string;
}

/**
 * Walks `source` looking for every identifier literally named `$`. An occurrence is allowed only
 * when it is:
 * - the name of a parameter declaration (the hook's own `$` parameter: `($, e, next) => ...`,
 *   or any other same-file function that declares its own `$`-named parameter, which is a fresh
 *   binding, not a reference to an outer hook's `$`, and so is never itself "$ escaping"); or
 * - the innermost expression of a two-level property-access chain that is itself the callee of a
 *   call expression, i.e. exactly `$.a.b(...)` (`$.ui.log(...)`, `$.fs.read(...)`, `$.session.
 *   cwd()`, ...).
 *
 * Anything else -- `$` passed bare as a call argument (`isCaptureEnabled($)`), a member of `$`
 * passed as a value (`makeFsCaptureStore($.fs, baseDir)`), `$` assigned to a variable
 * (`currentHost = $`, `const x = $`), `$` as a single-level call (`$.log(...)`) or any other shape
 * -- is a violation.
 *
 * 4.9.2 adds one more allowed shape: exactly `$.plugin.root` or `$.plugin.name` read as a value. `plugin` is the one
 * noun of the host API that is plain data rather than calls, and the host's own type file spells it that way in its
 * `$.fs.read` example (`` `${$.plugin.root}/hooks/weights.bin` ``). Any other `$.plugin` shape (bare `$.plugin`, a
 * different member, `$.plugin` passed as a value) is still a violation.
 */
function findDollarViolations(source: string, fileName: string): DollarViolation[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const violations: DollarViolation[] = [];

  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const isDollarNounEventCall = (identifier: ts.Identifier): boolean => {
    const nounAccess = identifier.parent;
    if (!ts.isPropertyAccessExpression(nounAccess) || nounAccess.expression !== identifier) return false;
    const eventAccess = nounAccess.parent;
    if (!ts.isPropertyAccessExpression(eventAccess) || eventAccess.expression !== nounAccess) return false;
    const call = eventAccess.parent;
    return ts.isCallExpression(call) && call.expression === eventAccess;
  };

  const isPluginDataRead = (identifier: ts.Identifier): boolean => {
    const nounAccess = identifier.parent;
    if (!ts.isPropertyAccessExpression(nounAccess) || nounAccess.expression !== identifier) return false;
    if (nounAccess.name.text !== 'plugin') return false;
    const memberAccess = nounAccess.parent;
    if (!ts.isPropertyAccessExpression(memberAccess) || memberAccess.expression !== nounAccess) return false;
    if (memberAccess.name.text !== 'root' && memberAccess.name.text !== 'name') return false;
    const user = memberAccess.parent;
    return !(ts.isCallExpression(user) && user.expression === memberAccess);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === '$') {
      const isParameterName = ts.isParameter(node.parent) && node.parent.name === node;
      if (!isParameterName && !isDollarNounEventCall(node) && !isPluginDataRead(node)) {
        violations.push({ line: lineOf(node), detail: node.parent.getText(sourceFile).slice(0, 100) });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

/**
 * The exact `session.compact` handler opening from `e66f9f03` (the debug log's own quoted line 21
 * is `isCaptureEnabled($)`; `makeFsCaptureStore($.fs, ...)` is the brief's "known further
 * violation", reproduced verbatim below, trimmed to the smallest fragment that still parses as a
 * standalone module and still exercises both shapes).
 */
const PRE_FIX_COMPACT_FRAGMENT = `
import { isCaptureEnabled } from './host/capture-flag.js';
import { makeFsCaptureStore } from './host/fs-adapter.js';

export const register = (on, options) => {
  on('session.compact', async ($, input, next) => {
    if (!(await isCaptureEnabled($))) return next(input);
    const store = makeFsCaptureStore($.fs, 'baseDir');
    return store;
  });
};
`;

/** The exact `currentHost = $` shape from `e66f9f03`'s `trigger.ts`. */
const PRE_FIX_TRIGGER_FRAGMENT = `
import { makeSoftTrigger } from './core/handler.js';

export const register = (on, options) => {
  let currentHost;
  const softTrigger = makeSoftTrigger(60, 200000, {
    getUsage: async () => (await currentHost?.session.usage())?.context,
    compact: async () => await currentHost?.session.compact(),
  });
  on('turn.complete', async ($, event, next) => {
    const result = await next(event);
    currentHost = $;
    await softTrigger.onTurnComplete();
    return result;
  });
};
`;

describe('dollar-spelling gate (round 11): the hook compiler\'s $ spelling rule', () => {
  it('RED: the pre-fix compact.ts shape (e66f9f03) is flagged -- isCaptureEnabled($) and makeFsCaptureStore($.fs, ...)', () => {
    const violations = findDollarViolations(PRE_FIX_COMPACT_FRAGMENT, 'compact.pre-fix.ts');
    const details = violations.map((v) => v.detail);
    expect(violations.length, 'the checker must be a real, discriminating check, not a vacuous pass').toBeGreaterThan(0);
    expect(details).toContain('isCaptureEnabled($)');
    expect(details.some((d) => d.includes('$.fs'))).toBe(true);
  });

  it('RED: the pre-fix trigger.ts shape (e66f9f03) is flagged -- currentHost = $', () => {
    const violations = findDollarViolations(PRE_FIX_TRIGGER_FRAGMENT, 'trigger.pre-fix.ts');
    const details = violations.map((v) => v.detail);
    expect(violations.length).toBeGreaterThan(0);
    expect(details).toContain('currentHost = $');
  });

  it('GREEN: the current compact.ts has no $ spelling violations', () => {
    const source = readFileSync(new URL('../compact.ts', import.meta.url), 'utf8');
    const violations = findDollarViolations(source, 'compact.ts');
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('GREEN: the current trigger.ts (exovault-s4-trigger) has no $ spelling violations', () => {
    const source = readFileSync(new URL('../../compact-trigger/trigger.ts', import.meta.url), 'utf8');
    const violations = findDollarViolations(source, 'trigger.ts');
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('the checker still accepts a same-file function receiving bare $ (compiler rule 1\'s own exception, unused by the actual fix but not something the checker need reject to pass today)', () => {
    // Documented for completeness: this gate is intentionally stricter than compiler rule 1 (see
    // header comment) and does NOT special-case this. A same-file helper called with bare `$`
    // still reads as a violation under this gate's rule, which is fine because the real fix never
    // does this (every closure is built inline). This test pins that intentional strictness so a
    // future reader is not surprised by it, rather than asserting the opposite.
    const source = `
      function helper($) { return $.fs.read('x'); }
      export const register = (on) => {
        on('session.compact', async ($, e, next) => {
          return helper($);
        });
      };
    `;
    const violations = findDollarViolations(source, 'same-file-helper.ts');
    expect(violations.map((v) => v.detail)).toContain('helper($)');
  });

  it('4.9.2: accepts exactly $.plugin.root / $.plugin.name as values and still flags every other $.plugin shape', () => {
    const source = `
      export const register = (on) => {
        on('session.compact', async ($, e, next) => {
          const root = $.plugin.root;
          await $.ui.log(\`\${$.plugin.name} at \${$.plugin.root}\`);
          const bare = $.plugin;
          const other = $.plugin.options;
          use($.plugin);
          return next(e);
        });
      };
    `;
    const lines = findDollarViolations(source, 'plugin-root.ts').map((v) => v.line);
    // Line 1 is the template's leading newline: the reads sit on 4 and 5, the three rejected shapes on 6, 7 and 8.
    expect(lines).toEqual([6, 7, 8]);
  });

  it('the checker accepts on("<event>", hook) and a plain next(e) call, and does not flag next.to', () => {
    const source = `
      export const register = (on) => {
        on('session.compact', async ($, e, next) => {
          $.ui.log('x');
          await next(e);
          return next.to(e, 'core');
        });
      };
    `;
    const violations = findDollarViolations(source, 'on-next.ts');
    expect(violations).toEqual([]);
  });
});
