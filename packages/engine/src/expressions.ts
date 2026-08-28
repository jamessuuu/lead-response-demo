/**
 * The subset of n8n's expression language the base workflow uses:
 *   {{ $json.<path> }}                       the previous node's output
 *   {{ $('Node Name').item.json.<path> }}    a named node's output
 * Anything else is refused loudly. The one If-node condition the workflow
 * carries is mirrored in branch.ts and pinned to the workflow file by a test.
 */
export interface ExprContext {
  json: unknown;
  nodeOutput: (name: string) => unknown;
}

export class UnsupportedExpressionError extends Error {
  constructor(expr: string) {
    super(`Unsupported n8n expression: ${expr}`);
    this.name = 'UnsupportedExpressionError';
  }
}

export class MissingValueError extends Error {
  constructor(expr: string) {
    super(`Expression resolved to undefined: ${expr}`);
    this.name = 'MissingValueError';
  }
}

/** Dotted paths with numeric indexes: `contact.id`, `conversations[0].lastMessageDirection`. */
export function getPath(obj: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((p) => p.length > 0);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const JSON_REF = /^\$json((?:\.[A-Za-z_$][\w$]*|\[\d+\])+)$/;
const NODE_REF = /^\$\('([^']+)'\)\.item\.json((?:\.[A-Za-z_$][\w$]*|\[\d+\])+)$/;

export function evaluate(rawExpr: string, ctx: ExprContext): unknown {
  const expr = rawExpr.trim();
  let m = JSON_REF.exec(expr);
  if (m) return getPath(ctx.json, m[1] as string);
  m = NODE_REF.exec(expr);
  if (m) return getPath(ctx.nodeOutput(m[1] as string), m[2] as string);
  throw new UnsupportedExpressionError(expr);
}

/** True when the parameter is an n8n expression (leading `=`). */
export function isExpression(value: string): boolean {
  return value.startsWith('=');
}

/**
 * Render an n8n string parameter. Literal strings pass through untouched;
 * expression strings (`=...`) have every `{{ }}` evaluated and interpolated.
 * Undefined values are an error, not an empty string: silent blanks are how
 * template drift hides.
 */
export function renderTemplate(value: string, ctx: ExprContext): string {
  if (!isExpression(value)) return value;
  const body = value.slice(1);
  return body.replace(/\{\{([\s\S]*?)\}\}/g, (_match, inner: string) => {
    const result = evaluate(inner, ctx);
    if (result === undefined) throw new MissingValueError(inner.trim());
    if (result === null) return 'null';
    if (typeof result === 'object') return JSON.stringify(result);
    return String(result);
  });
}

/** Replace every REPLACE_* token; an unknown token is an error so it cannot leak. */
export function applyPlaceholders(value: string, placeholders: Record<string, string>): string {
  return value.replace(/REPLACE_[A-Z0-9_]+/g, (token) => {
    const replacement = placeholders[token];
    if (replacement === undefined) throw new Error(`No placeholder value for ${token}`);
    return replacement;
  });
}
