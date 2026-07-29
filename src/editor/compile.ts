/**
 * TSX → playable module, with every JSX element tagged back to its source.
 *
 * Pipeline (mirrors bazaar-vid's PreviewPanelG, minus app plumbing):
 *   1. tag      — parse the STORED TSX with @babel/parser and inject
 *                 data-baz="<sceneId>:<line>:<col>" on every lowercase JSX
 *                 element. line:col identify the JSXOpeningElement in the
 *                 stored source — that's the id the patcher resolves later.
 *   2. scrub    — strip imports, de-export declarations (regex, as the app does).
 *   3. compile  — sucrase ['typescript','jsx'], classic runtime.
 *   4. module   — append an `export default` root; evaluate as a blob ES module.
 *
 * Tagging happens in memory only; the stored TSX never contains tags, so
 * source locations always refer to what's in the database.
 */
import { parse } from '@babel/parser';
import { transform } from 'sucrase';

export interface CompiledScene {
  blobUrl: string;
  componentName: string;
  error?: string;
}

interface JsxTagSite {
  /** offset just after the tag name, where ` data-baz="…"` gets inserted */
  insertAt: number;
  line: number;
  column: number;
  tagName: string;
}

/** Collect every lowercase (DOM) JSX opening element with its source loc. */
function collectTagSites(tsx: string): JsxTagSite[] {
  const ast = parse(tsx, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
    errorRecovery: true,
  });

  const sites: JsxTagSite[] = [];
  // Manual walk — @babel/traverse drags in half of Babel; the AST is plain JSON.
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as Record<string, unknown> & {
      type?: string;
      loc?: { start: { line: number; column: number } };
    };
    if (n.type === 'JSXOpeningElement') {
      const name = n.name as { type: string; name?: string; end?: number } | undefined;
      // Only plain lowercase DOM tags: components swallow unknown props, so a
      // data-baz on <MyCard> never reaches the DOM — skip them.
      if (name?.type === 'JSXIdentifier' && name.name && /^[a-z]/.test(name.name) && typeof name.end === 'number' && n.loc) {
        sites.push({
          insertAt: name.end,
          line: n.loc.start.line,
          column: n.loc.start.column,
          tagName: name.name,
        });
      }
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc') continue;
      walk(n[key]);
    }
  };
  walk(ast.program);
  return sites;
}

/** Inject data-baz attributes, bottom-up so earlier offsets stay valid. */
export function tagJsx(tsx: string, sceneId: string): string {
  let sites: JsxTagSite[];
  try {
    sites = collectTagSites(tsx);
  } catch {
    return tsx; // unparseable → play untagged rather than not at all
  }
  let out = tsx;
  for (const site of [...sites].sort((a, b) => b.insertAt - a.insertAt)) {
    out =
      out.slice(0, site.insertAt) +
      ` data-baz="${sceneId}:${site.line}:${site.column}"` +
      out.slice(site.insertAt);
  }
  return out;
}

/** Strip imports / de-export declarations — the app's scrub, minimally ported. */
export function scrub(tsx: string): { code: string; componentName: string | null } {
  let code = tsx
    .replace(/^import\s+[^;]+;?\s*$/gm, '')
    .replace(/^\s*const\s+React\s*=\s*window\.React\s*;?\s*$/gm, '');

  let componentName: string | null = null;

  code = code.replace(/export\s+default\s+function\s+(\w+)/, (_m, name) => {
    componentName = name;
    return `function ${name}`;
  });
  const trailing = code.match(/export\s+default\s+(\w+)\s*;?/);
  if (trailing) {
    componentName = componentName || trailing[1];
    code = code.replace(/export\s+default\s+\w+\s*;?/, '');
  }
  code = code.replace(/^export\s+const\s+/gm, 'const ');
  return { code, componentName };
}

const revokeQueue: string[] = [];

/**
 * Compile one scene into a playable blob-ESM module.
 * The module's default export renders the scene inside an AbsoluteFill.
 */
export function compileScene(tsx: string, sceneId: string): CompiledScene {
  try {
    const tagged = tagJsx(tsx, sceneId);
    const { code: scrubbed, componentName } = scrub(tagged);
    if (!componentName) throw new Error('no default-exported component found');

    const moduleSrc = [
      'const React = window.React;',
      scrubbed,
      // Per-scene error boundary, same idea as the app's string-generated one:
      // a broken scene renders an error card, not a white screen.
      `class __BazBoundary extends React.Component {
         constructor(p){ super(p); this.state = { err: null }; }
         static getDerivedStateFromError(err){ return { err }; }
         render(){
           if (this.state.err) {
             return React.createElement(window.Remotion.AbsoluteFill,
               { style: { background: '#1a0000', color: '#ff8a8a', fontFamily: 'monospace',
                          fontSize: 28, padding: 60 } },
               'Scene runtime error: ' + String(this.state.err && this.state.err.message));
           }
           return React.createElement(${componentName});
         }
       }`,
      'export default function __BazRoot(){ return React.createElement(__BazBoundary); }',
    ].join('\n');

    const js = transform(moduleSrc, {
      transforms: ['typescript', 'jsx'],
      jsxRuntime: 'classic',
      production: true,
    }).code;

    const blobUrl = URL.createObjectURL(new Blob([js], { type: 'application/javascript' }));
    // Revoke old modules on a delay so a mid-swap Player keeps working.
    revokeQueue.push(blobUrl);
    while (revokeQueue.length > 4) {
      const old = revokeQueue.shift();
      if (old) setTimeout(() => URL.revokeObjectURL(old), 5000);
    }
    return { blobUrl, componentName };
  } catch (err) {
    return { blobUrl: '', componentName: '', error: (err as Error).message };
  }
}
