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
const WRAP_RE = /data-bazwrap\s+style=\{\{\s*transform:\s*'translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)'\s*\}\}/;

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

/** A translate that WE emitted: plain 'translate(Xpx, Ypx)' string, nothing else. */
const OURS_RE = /^translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)$/;

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
  let found: ReturnType<typeof findElementAt>;
  try {
    found = findElementAt(tsx, line, column);
  } catch {
    return null;
  }
  if (!found) return null;

  const { node, parent } = found;
  const rx = Math.round(dx * 10) / 10;
  const ry = Math.round(dy * 10) / 10;

  // 1. merge into an existing wrapper
  if (isOurWrapper(parent) && parent) {
    const open = parent.openingElement!;
    const openSrc = tsx.slice(open.start, open.end);
    const m = WRAP_RE.exec(openSrc);
    if (!m) return null; // wrapper edited by someone else — don't guess
    const nx = Math.round((parseFloat(m[1]) + dx) * 10) / 10;
    const ny = Math.round((parseFloat(m[2]) + dy) * 10) / 10;
    const newOpen = openSrc.replace(WRAP_RE, `data-bazwrap style={{ transform: 'translate(${nx}px, ${ny}px)' }}`);
    return tsx.slice(0, open.start) + newOpen + tsx.slice(open.end);
  }

  const style = inspectStyle(node);

  // 2. merge into our own earlier in-place translate
  if (style.transform?.value) {
    const m = OURS_RE.exec(style.transform.value);
    if (m) {
      const nx = Math.round((parseFloat(m[1]) + dx) * 10) / 10;
      const ny = Math.round((parseFloat(m[2]) + dy) * 10) / 10;
      return tsx.slice(0, style.transform.start) + `'translate(${nx}px, ${ny}px)'` + tsx.slice(style.transform.end);
    }
  }

  // 3. no transform → inject into the element's own style (layout-neutral)
  if (!style.transform && !style.opaque) {
    if (style.objStart !== null) {
      const insert = style.objStart + 1; // just inside the '{'
      return tsx.slice(0, insert) + ` transform: 'translate(${rx}px, ${ry}px)',` + tsx.slice(insert);
    }
    // no style attribute at all → add one right after the tag name
    const nameEnd = node.openingElement?.name?.end;
    if (typeof nameEnd === 'number') {
      return tsx.slice(0, nameEnd) + ` style={{ transform: 'translate(${rx}px, ${ry}px)' }}` + tsx.slice(nameEnd);
    }
    return null;
  }

  // 4. foreign transform (often animated) → wrapper, composes safely
  const before = `<div ${WRAP_ATTR} style={{ transform: 'translate(${rx}px, ${ry}px)' }}>`;
  return (
    tsx.slice(0, node.start) + before + tsx.slice(node.start, node.end) + '</div>' + tsx.slice(node.end)
  );
}
