/**
 * Wrapper-transform patcher: turn "move element at line:col by (dx,dy)" into a
 * TSX edit.
 *
 * Strategy (per plan): never rewrite the element's own math — wrap it.
 *
 *   <div data-bazwrap style={{ transform: 'translate(12px, -30px)' }}>
 *     <original element … />
 *   </div>
 *
 * A transform on the wrapper composes with whatever animation the element does
 * internally. If the target's PARENT is already one of our wrappers, we merge
 * deltas into it instead of nesting — repeated drags stay one wrapper deep.
 *
 * Locs always refer to the CURRENT stored TSX: after every save the scene is
 * recompiled and retagged, so ids and source stay consistent.
 */
import { parse } from '@babel/parser';

interface JsxNode {
  type: string;
  start: number;
  end: number;
  loc: { start: { line: number; column: number } };
  openingElement?: {
    start: number;
    end: number;
    loc: { start: { line: number; column: number } };
    name?: { end: number };
    attributes?: Array<{ type: string; name?: { name?: string }; value?: unknown; start: number; end: number }>;
  };
}

const WRAP_ATTR = 'data-bazwrap';
// Our emitted transform grammar: translate always, scale optional.
const WRAP_RE = /data-bazwrap\s+style=\{\{\s*transform:\s*'translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)(?:\s*scale\((-?[\d.]+)\))?'\s*\}\}/;

const fmt = (n: number) => Math.round(n * 1000) / 1000;
const transformStr = (x: number, y: number, k: number) =>
  `translate(${fmt(x)}px, ${fmt(y)}px)${fmt(k) !== 1 ? ` scale(${fmt(k)})` : ''}`;

function findElementAt(tsx: string, line: number, column: number): { node: JsxNode; parent: JsxNode | null } | null {
  const ast = parse(tsx, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true });
  let hit: { node: JsxNode; parent: JsxNode | null } | null = null;

  const walk = (node: unknown, parentJsx: JsxNode | null): void => {
    if (!node || typeof node !== 'object' || hit) return;
    if (Array.isArray(node)) return node.forEach((c) => walk(c, parentJsx));
    const n = node as Record<string, unknown> & JsxNode;
    let nextParent = parentJsx;
    if (n.type === 'JSXElement') {
      const open = n.openingElement;
      if (open && open.loc.start.line === line && open.loc.start.column === column) {
        hit = { node: n, parent: parentJsx };
        return;
      }
      nextParent = n;
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc') continue;
      walk(n[key], nextParent);
    }
  };
  walk(ast.program, null);
  return hit;
}

function isOurWrapper(node: JsxNode | null): boolean {
  if (!node?.openingElement?.attributes) return false;
  return node.openingElement.attributes.some(
    (a) => a.type === 'JSXAttribute' && a.name?.name === WRAP_ATTR
  );
}

/** A transform WE emitted: 'translate(Xpx, Ypx)' with optional ' scale(K)'. */
const OURS_RE = /^translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)(?:\s*scale\((-?[\d.]+)\))?$/;

interface StyleInfo {
  /** ObjectExpression node of style={{ … }} — null if style is absent/opaque */
  objStart: number | null;
  /** existing transform property value if present */
  transform: { start: number; end: number; value: string | null } | null;
  /** true when a style attribute exists but isn't a plain object literal */
  opaque: boolean;
}

function inspectStyle(node: JsxNode): StyleInfo {
  const attrs = node.openingElement?.attributes || [];
  for (const a of attrs as Array<Record<string, unknown>>) {
    if (a.type !== 'JSXAttribute') continue;
    const name = (a.name as { name?: string })?.name;
    if (name !== 'style') continue;
    const val = a.value as { type?: string; expression?: Record<string, unknown> } | undefined;
    const expr = val?.type === 'JSXExpressionContainer' ? val.expression : null;
    if (!expr || expr.type !== 'ObjectExpression') return { objStart: null, transform: null, opaque: true };
    for (const p of (expr.properties as Array<Record<string, unknown>>) || []) {
      if (p.type !== 'ObjectProperty') continue;
      const key = p.key as { name?: string; value?: string };
      if ((key?.name || key?.value) === 'transform') {
        const v = p.value as { type?: string; value?: string; start: number; end: number };
        return {
          objStart: expr.start as number,
          transform: {
            start: v.start,
            end: v.end,
            value: v.type === 'StringLiteral' ? (v.value as string) : null,
          },
          opaque: false,
        };
      }
    }
    return { objStart: expr.start as number, transform: null, opaque: false };
  }
  return { objStart: null, transform: null, opaque: false };
}

/**
 * Apply a translate delta (in the element's local px) to the element at
 * (line,col). Strategy ladder, least-invasive first:
 *
 *   1. parent is our wrapper           → merge numbers into the wrapper
 *   2. element has OUR translate       → merge numbers in place
 *   3. element has NO transform        → inject into its own style object —
 *      layout-neutral (transform never affects flow), so nothing shifts
 *      after the drop the way an extra wrapper div could inside flex parents
 *   4. element has a foreign transform → wrap (composes with animation math)
 *
 * Returns patched TSX or null (caller falls back to a Claude note).
 */
export function applyTranslate(tsx: string, line: number, column: number, dx: number, dy: number): string | null {
  return applyTransform(tsx, line, column, dx, dy, 1);
}

/** Translate + uniform scale, same strategy ladder as before. */
export function applyTransform(
  tsx: string,
  line: number,
  column: number,
  dx: number,
  dy: number,
  dScale: number
): string | null {
  let found: ReturnType<typeof findElementAt>;
  try {
    found = findElementAt(tsx, line, column);
  } catch {
    return null;
  }
  if (!found) return null;

  const { node, parent } = found;

  // 1. merge into an existing wrapper
  if (isOurWrapper(parent) && parent) {
    const open = parent.openingElement!;
    const openSrc = tsx.slice(open.start, open.end);
    const m = WRAP_RE.exec(openSrc);
    if (!m) return null; // wrapper edited by someone else — don't guess
    const t = transformStr(parseFloat(m[1]) + dx, parseFloat(m[2]) + dy, (m[3] ? parseFloat(m[3]) : 1) * dScale);
    const newOpen = openSrc.replace(WRAP_RE, `data-bazwrap style={{ transform: '${t}' }}`);
    return tsx.slice(0, open.start) + newOpen + tsx.slice(open.end);
  }

  const style = inspectStyle(node);

  // 2. merge into our own earlier in-place transform
  if (style.transform?.value) {
    const m = OURS_RE.exec(style.transform.value);
    if (m) {
      const t = transformStr(parseFloat(m[1]) + dx, parseFloat(m[2]) + dy, (m[3] ? parseFloat(m[3]) : 1) * dScale);
      return tsx.slice(0, style.transform.start) + `'${t}'` + tsx.slice(style.transform.end);
    }
  }

  // 3. no transform → inject into the element's own style (layout-neutral)
  if (!style.transform && !style.opaque) {
    const t = transformStr(dx, dy, dScale);
    if (style.objStart !== null) {
      const insert = style.objStart + 1; // just inside the '{'
      return tsx.slice(0, insert) + ` transform: '${t}',` + tsx.slice(insert);
    }
    // no style attribute at all → add one right after the tag name
    const nameEnd = node.openingElement?.name?.end;
    if (typeof nameEnd === 'number') {
      return tsx.slice(0, nameEnd) + ` style={{ transform: '${t}' }}` + tsx.slice(nameEnd);
    }
    return null;
  }

  // 4. foreign transform (often animated) → wrapper, composes safely
  const before = `<div ${WRAP_ATTR} style={{ transform: '${transformStr(dx, dy, dScale)}' }}>`;
  return (
    tsx.slice(0, node.start) + before + tsx.slice(node.start, node.end) + '</div>' + tsx.slice(node.end)
  );
}

// ---------------------------------------------------------------------------
// Trim-in: cut the first N frames of a scene's CONTENT.
//
// The platform's timing metadata has no trim-in field, so the trim must live
// in the scene TSX itself to survive Lambda export: wrap the default
// component's root JSX in a negative-offset Sequence — the standard Remotion
// idiom for playing a clip from N frames in. Scenes already run inside an
// outer Sequence (frame 0 at scene start), so `from={-N}` shifts their whole
// internal timeline, animations and audio alike. `window.Remotion.Sequence`
// is spelled out because that global is the one contract every scene and the
// Lambda runtime share; scene-local destructured names can't be relied on.
// ---------------------------------------------------------------------------

const TRIM_OPEN_RE = /<window\.Remotion\.Sequence from=\{-(\d+)\} layout="none" data-baztrim>/;
const TRIM_CLOSE = '</window.Remotion.Sequence>';

/** Frames currently trimmed off the scene's start (0 = no wrapper). */
export function getTrimIn(tsx: string): number {
  const m = TRIM_OPEN_RE.exec(tsx);
  return m ? parseInt(m[1], 10) : 0;
}

interface FnNode {
  type: string;
  body?: unknown;
  id?: { name?: string };
}

/**
 * Root JSX nodes of the default-exported component: every top-level
 * `return <jsx>` in its body (conditional returns each get wrapped), or the
 * body itself for an implicit-return arrow. Does NOT descend into nested
 * functions — a `return` inside a .map() callback is not a component root.
 */
function findComponentRoots(tsx: string): Array<{ start: number; end: number }> | null {
  let program: unknown;
  try {
    program = parse(tsx, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true }).program;
  } catch {
    return null;
  }
  const body = (program as { body: Array<Record<string, unknown>> }).body;

  let fn: FnNode | null = null;
  let defaultName: string | null = null;
  for (const stmt of body) {
    if (stmt.type !== 'ExportDefaultDeclaration') continue;
    const d = stmt.declaration as Record<string, unknown>;
    if (d.type === 'FunctionDeclaration' || d.type === 'ArrowFunctionExpression' || d.type === 'FunctionExpression') {
      fn = d as unknown as FnNode;
    } else if (d.type === 'Identifier') {
      defaultName = (d as unknown as { name: string }).name;
    }
  }
  if (!fn && defaultName) {
    for (const stmt of body) {
      if (stmt.type === 'FunctionDeclaration' && (stmt.id as { name?: string })?.name === defaultName) {
        fn = stmt as unknown as FnNode;
      }
      if (stmt.type === 'VariableDeclaration') {
        for (const dec of stmt.declarations as Array<Record<string, unknown>>) {
          if ((dec.id as { name?: string })?.name === defaultName) {
            const init = dec.init as Record<string, unknown> | null;
            if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
              fn = init as unknown as FnNode;
            }
          }
        }
      }
    }
  }
  if (!fn) return null;

  const fnBody = fn.body as Record<string, unknown>;
  // Implicit-return arrow: the body IS the root JSX.
  if (fnBody.type === 'JSXElement' || fnBody.type === 'JSXFragment') {
    return [{ start: fnBody.start as number, end: fnBody.end as number }];
  }

  const roots: Array<{ start: number; end: number }> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as Record<string, unknown>;
    // Stay inside THIS component: nested function bodies own their returns.
    if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') return;
    if (n.type === 'ReturnStatement') {
      const arg = n.argument as Record<string, unknown> | null;
      if (arg && (arg.type === 'JSXElement' || arg.type === 'JSXFragment')) {
        roots.push({ start: arg.start as number, end: arg.end as number });
      }
      return;
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc') continue;
      walk(n[key]);
    }
  };
  walk(fnBody);
  return roots.length ? roots : null;
}

/**
 * Set the ABSOLUTE trim-in to `frames`. Updates an existing wrapper's offset,
 * unwraps entirely at 0, or wraps every component root. Returns null when the
 * component shape can't be resolved — caller should refuse rather than guess.
 */
export function applyTrimIn(tsx: string, frames: number): string | null {
  const n = Math.max(0, Math.round(frames));
  const existing = TRIM_OPEN_RE.exec(tsx);

  if (existing) {
    if (n === parseInt(existing[1], 10)) return tsx;
    if (n > 0) {
      return tsx.replace(
        new RegExp(TRIM_OPEN_RE.source, 'g'),
        `<window.Remotion.Sequence from={-${n}} layout="none" data-baztrim>`
      );
    }
    // n === 0 → unwrap every wrapper (conditional-return scenes have several)
    let out = tsx;
    let m: RegExpExecArray | null;
    while ((m = TRIM_OPEN_RE.exec(out))) {
      const openStart = m.index;
      const innerStart = openStart + m[0].length;
      const closeStart = out.indexOf(TRIM_CLOSE, innerStart);
      if (closeStart < 0) return null;
      out = out.slice(0, openStart) + out.slice(innerStart, closeStart) + out.slice(closeStart + TRIM_CLOSE.length);
    }
    return out;
  }

  if (n === 0) return tsx;
  const roots = findComponentRoots(tsx);
  if (!roots) return null;
  let out = tsx;
  for (const r of [...roots].sort((a, b) => b.start - a.start)) {
    out =
      out.slice(0, r.start) +
      `<window.Remotion.Sequence from={-${n}} layout="none" data-baztrim>` +
      out.slice(r.start, r.end) +
      TRIM_CLOSE +
      out.slice(r.end);
  }
  return out;
}

/**
 * Replace an element's PURE-TEXT content, for double-click inline editing.
 * Only applies when the children are static text (JSXText nodes, or a single
 * {"string"} expression we wrote earlier). Anything code-generated returns
 * null — that text belongs to a prompt, not a caret.
 */
export function applyTextEdit(tsx: string, line: number, column: number, newText: string): string | null {
  let found: ReturnType<typeof findElementAt>;
  try {
    found = findElementAt(tsx, line, column);
  } catch {
    return null;
  }
  if (!found) return null;
  const node = found.node as JsxNode & {
    children?: Array<{ type: string; start: number; end: number; expression?: { type?: string } }>;
  };
  const kids = (node.children || []).filter(
    (c) => !(c.type === 'JSXText' && tsx.slice(c.start, c.end).trim() === '')
  );
  if (!kids.length) return null;
  const pure = kids.every(
    (c) =>
      c.type === 'JSXText' ||
      (c.type === 'JSXExpressionContainer' && c.expression?.type === 'StringLiteral')
  );
  if (!pure) return null;
  const from = Math.min(...kids.map((c) => c.start));
  const to = Math.max(...kids.map((c) => c.end));
  // JSON-stringified expression child: safe for braces, angles, quotes, emoji.
  return tsx.slice(0, from) + `{${JSON.stringify(newText)}}` + tsx.slice(to);
}
