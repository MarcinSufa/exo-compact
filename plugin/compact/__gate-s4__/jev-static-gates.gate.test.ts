import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * review-opus-s4b-r2.md F1: two mutation gaps the review found still green, closed here as static
 * (TS-AST) gates over `compact.ts`'s own source, the same style `dollar-spelling.gate.test.ts`
 * already uses for a source-shape invariant no unit test over injected fakes can see:
 *
 * 1. The literal key read (B1, review-opus-s4b.md): `jev-client.gate.test.ts`'s own header only
 *    described the requirement in a comment; nothing actually scanned for it. "I replaced the
 *    literal with a const variable, `$.env.get(KEYNAME)`, and all 432 tests stayed green" (status
 *    table, B1 row). The host statically scans `compact.ts`'s own source for the literal spelling
 *    `$.env.get('TYPESAFE_API_KEY')` (types/cc.d.ts): a variable, a forwarded parameter, or any
 *    other non-literal argument silently loses the access it appears to grant at the type level,
 *    which no runtime test (the value still "works" against a fake host) can ever catch.
 * 2. The abort signal wiring at compact.ts:243 (F1's own status row): "replacing `signal` at
 *    compact.ts:243 with a fresh signal stays green" -- a mutant that swaps the outer `run(signal)`
 *    parameter for `new AbortController().signal` when calling `selectJ` passes every existing
 *    test, because nothing in the fake-host harness ever drives the outer `withFallback` race to
 *    actually time out while a Jev batch is in flight (a real behavioral test would need timing
 *    control tight enough to be its own source of flakiness). The wiring itself -- "the same signal
 *    object, not a fresh one" -- is a source-shape fact, checked directly here instead.
 */

// ---------------------------------------------------------------------------------------------
// 1. Env literal gate.
// ---------------------------------------------------------------------------------------------

interface EnvLiteralViolation {
  line: number;
  detail: string;
}

/** Matches `$.env.get(...)` or `$.env.set(...)`, the exact two-level `$.env.<method>` shape. */
function isDollarEnvCall(expr: ts.Expression, method: 'get' | 'set'): boolean {
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== method) return false;
  const envAccess = expr.expression;
  return ts.isPropertyAccessExpression(envAccess) && envAccess.name.text === 'env' && ts.isIdentifier(envAccess.expression) && envAccess.expression.text === '$';
}

/**
 * Every `$.env.get(...)` / `$.env.set(...)` call's first argument must be a string literal (a
 * const-bound variable, a forwarded parameter, a template expression, anything computed -- all
 * flagged). This is the actual grant the host's own static scan checks (types/cc.d.ts), so a
 * closure that merely LOOKS like it reads one literal name, but actually forwards a variable, must
 * fail this gate even though it still type-checks and still "works" against every fake host.
 */
function findEnvLiteralViolations(source: string, fileName: string): EnvLiteralViolation[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const violations: EnvLiteralViolation[] = [];
  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && (isDollarEnvCall(node.expression, 'get') || isDollarEnvCall(node.expression, 'set'))) {
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteral(arg)) {
        violations.push({ line: lineOf(node), detail: node.getText(sourceFile).slice(0, 120) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

const PRE_FIX_CONST_VARIABLE_FRAGMENT = `
export const envLike = {
  getTypeSafeApiKey: () => {
    const KEYNAME = 'TYPESAFE_API_KEY';
    return $.env.get(KEYNAME);
  },
};
`;

const PRE_FIX_FORWARDED_PARAMETER_FRAGMENT = `
export function makeEnvLike(name) {
  return { getTypeSafeApiKey: () => $.env.get(name) };
}
`;

describe('env literal gate (review-opus-s4b-r2.md B1/F1): $.env.get/set arguments must be string literals', () => {
  it('RED: a const-bound variable in place of the literal is flagged', () => {
    const violations = findEnvLiteralViolations(PRE_FIX_CONST_VARIABLE_FRAGMENT, 'const-variable.ts');
    expect(violations.length, 'the checker must be a real, discriminating check, not a vacuous pass').toBeGreaterThan(0);
    expect(violations[0].detail).toContain('$.env.get(KEYNAME)');
  });

  it('RED: a forwarded parameter in place of the literal is flagged', () => {
    const violations = findEnvLiteralViolations(PRE_FIX_FORWARDED_PARAMETER_FRAGMENT, 'forwarded-parameter.ts');
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].detail).toContain('$.env.get(name)');
  });

  it('the checker accepts a genuine string literal argument', () => {
    const violations = findEnvLiteralViolations(`const x = () => $.env.get('TYPESAFE_API_KEY');`, 'literal.ts');
    expect(violations).toEqual([]);
  });

  it('GREEN: compact.ts has zero non-literal $.env.get/set calls, and contains the literal TYPESAFE_API_KEY read', () => {
    const source = readFileSync(new URL('../compact.ts', import.meta.url), 'utf8');
    const violations = findEnvLiteralViolations(source, 'compact.ts');
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    expect(source, 'the one literal key read B1 requires must still be present, spelled directly').toMatch(/\$\.env\.get\(\s*'TYPESAFE_API_KEY'\s*\)/);
  });

  it('GREEN: trigger.ts (exovault-s4-trigger) has zero non-literal $.env.get/set calls', () => {
    const source = readFileSync(new URL('../../compact-trigger/trigger.ts', import.meta.url), 'utf8');
    const violations = findEnvLiteralViolations(source, 'trigger.ts');
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Abort signal wiring gate (compact.ts:243, review-opus-s4b-r2.md F1).
// ---------------------------------------------------------------------------------------------

interface SignalWiringResult {
  ok: boolean;
  detail: string;
}

/**
 * Finds `withFallback({ run: async (signal) => { ... selectJ(..., { ..., signal }) ... }, ... })`
 * and checks that whatever value is passed as `selectJ`'s own `signal` property is exactly an
 * `Identifier` referring to the SAME name as `run`'s own first parameter -- never a fresh
 * `AbortController().signal`, a renamed shadow, or anything else that only happens to type-check.
 * Handles both the shorthand (`signal,`) and explicit (`signal: someExpr`) property forms.
 */
function checkSelectJSignalWiring(source: string, fileName: string): SignalWiringResult {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let result: SignalWiringResult = { ok: false, detail: 'no withFallback({ run: async (signal) => ... }) call found' };

  const findSelectJCall = (node: ts.Node): ts.CallExpression | undefined => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'selectJ') return node;
    let found: ts.CallExpression | undefined;
    ts.forEachChild(node, (child) => {
      if (!found) found = findSelectJCall(child);
    });
    return found;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'withFallback') {
      const configArg = node.arguments[0];
      if (configArg && ts.isObjectLiteralExpression(configArg)) {
        const runProp = configArg.properties.find(
          (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'run',
        );
        const runFn = runProp?.initializer;
        if (runFn && (ts.isArrowFunction(runFn) || ts.isFunctionExpression(runFn))) {
          const param = runFn.parameters[0];
          const paramName = param && ts.isIdentifier(param.name) ? param.name.text : undefined;
          if (paramName && runFn.body) {
            const selectJCall = findSelectJCall(runFn.body);
            if (!selectJCall) {
              result = { ok: false, detail: 'no selectJ(...) call found inside withFallback\'s run()' };
            } else {
              const depsArg = selectJCall.arguments[selectJCall.arguments.length - 1];
              if (!depsArg || !ts.isObjectLiteralExpression(depsArg)) {
                result = { ok: false, detail: 'selectJ(...) has no object-literal deps argument' };
              } else {
                const signalProp = depsArg.properties.find(
                  (p) => (ts.isShorthandPropertyAssignment(p) && p.name.text === 'signal') || (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'signal'),
                );
                if (!signalProp) {
                  result = { ok: false, detail: 'selectJ(...)\'s deps object has no "signal" property' };
                } else if (ts.isShorthandPropertyAssignment(signalProp)) {
                  result = { ok: signalProp.name.text === paramName, detail: `signal (shorthand) = ${signalProp.name.text}, run's own param = ${paramName}` };
                } else if (ts.isPropertyAssignment(signalProp)) {
                  const init = signalProp.initializer;
                  const ok = ts.isIdentifier(init) && init.text === paramName;
                  result = { ok, detail: `signal: ${init.getText(sourceFile)}, run's own param = ${paramName}` };
                }
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return result;
}

const CORRECT_WIRING_FRAGMENT = `
export const register = (on, options) => {
  on('session.compact', async ($, input, next) => {
    const result = await withFallback({
      run: async (signal) => {
        const jevResult = await selectJ(reasoningCandidates, selectQuery, reasoningBudgetTokens, {
          ask: makeJevAsk(httpLike, apiKey, jevModel),
          hash: sha256,
          signal,
        });
        return jevResult;
      },
      next: async () => {},
    });
  });
};
`;

const FRESH_CONTROLLER_MUTANT_FRAGMENT = `
export const register = (on, options) => {
  on('session.compact', async ($, input, next) => {
    const result = await withFallback({
      run: async (signal) => {
        const jevResult = await selectJ(reasoningCandidates, selectQuery, reasoningBudgetTokens, {
          ask: makeJevAsk(httpLike, apiKey, jevModel),
          hash: sha256,
          signal: new AbortController().signal,
        });
        return jevResult;
      },
      next: async () => {},
    });
  });
};
`;

const RENAMED_MISMATCH_MUTANT_FRAGMENT = `
export const register = (on, options) => {
  on('session.compact', async ($, input, next) => {
    const outerAbort = new AbortController();
    const result = await withFallback({
      run: async (signal) => {
        const jevResult = await selectJ(reasoningCandidates, selectQuery, reasoningBudgetTokens, {
          ask: makeJevAsk(httpLike, apiKey, jevModel),
          hash: sha256,
          signal: outerAbort.signal,
        });
        return jevResult;
      },
      next: async () => {},
    });
  });
};
`;

describe('abort signal wiring gate (review-opus-s4b-r2.md F1, compact.ts:243)', () => {
  it('RED: a fresh AbortController().signal in place of the outer run(signal) is flagged', () => {
    const result = checkSelectJSignalWiring(FRESH_CONTROLLER_MUTANT_FRAGMENT, 'fresh-controller-mutant.ts');
    expect(result.ok, result.detail).toBe(false);
  });

  it('RED: an unrelated, differently-named AbortController in place of the outer run(signal) is flagged', () => {
    const result = checkSelectJSignalWiring(RENAMED_MISMATCH_MUTANT_FRAGMENT, 'renamed-mismatch-mutant.ts');
    expect(result.ok, result.detail).toBe(false);
  });

  it('the checker accepts the correct shape (shorthand signal, matching run\'s own parameter name)', () => {
    const result = checkSelectJSignalWiring(CORRECT_WIRING_FRAGMENT, 'correct-shape.ts');
    expect(result.ok, result.detail).toBe(true);
  });

  it('GREEN: compact.ts wires the outer withFallback race\'s own signal straight into selectJ, not a fresh one', () => {
    const source = readFileSync(new URL('../compact.ts', import.meta.url), 'utf8');
    const result = checkSelectJSignalWiring(source, 'compact.ts');
    expect(result.ok, result.detail).toBe(true);
  });
});
