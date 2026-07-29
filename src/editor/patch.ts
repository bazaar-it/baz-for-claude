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

/**
 * Apply a translate delta to the element at (line,col) of `tsx`.
 * Returns the patched TSX, or null when the element can't be resolved
 * (caller falls back to a Claude note — the hybrid path).
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

  // Merge into an existing wrapper (element already dragged before).
  if (isOurWrapper(parent) && parent) {
    const open = parent.openingElement!;
    const openSrc = tsx.slice(open.start, open.end);
    const m = WRAP_RE.exec(openSrc);
    if (m) {
      const nx = Math.round((parseFloat(m[1]) + dx) * 10) / 10;
      const ny = Math.round((parseFloat(m[2]) + dy) * 10) / 10;
      const newOpen = openSrc.replace(
        WRAP_RE,
        `data-bazwrap style={{ transform: 'translate(${nx}px, ${ny}px)' }}`
      );
      return tsx.slice(0, open.start) + newOpen + tsx.slice(open.end);
    }
    // Wrapper exists but doesn't match our emitted shape (agent edited it?) —
    // don't guess at someone else's code.
    return null;
  }

  const rx = Math.round(dx * 10) / 10;
  const ry = Math.round(dy * 10) / 10;
  const before = `<div ${WRAP_ATTR} style={{ transform: 'translate(${rx}px, ${ry}px)' }}>`;
  return (
    tsx.slice(0, node.start) + before + tsx.slice(node.start, node.end) + '</div>' + tsx.slice(node.end)
  );
}
