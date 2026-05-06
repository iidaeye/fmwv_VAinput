// CSS / JS をインライン展開し、FM の data:URL に流せる単一 HTML を生成。
// import 文は単純な依存解決で連結（外部 npm 依存なし、相対パスのみ対応）。
//
// usage: node build/build.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const srcDir = resolve(root, 'src');
const entryHtml = resolve(srcDir, 'index.html');
const entryJs = resolve(srcDir, 'js/app.js');
const outFile = resolve(root, 'build/index.bundle.html');

// --- ESM をフラットなスクリプトに連結 ---

const moduleCache = new Map();   // absPath -> { exportsId, code }
const order = [];

function moduleId(absPath) {
  return '__mod_' + relative(srcDir, absPath).replace(/[^a-zA-Z0-9]+/g, '_');
}

function bundleModule(absPath) {
  if (moduleCache.has(absPath)) return moduleCache.get(absPath).exportsId;
  const exportsId = moduleId(absPath);
  moduleCache.set(absPath, { exportsId, code: '' });

  let code = readFileSync(absPath, 'utf8');

  // import ... from './x.js'  →  const ... = __mod_x;
  code = code.replace(
    /import\s+(\*\s+as\s+(\w+)|\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (match, _g1, ns, named, def, path) => {
      const childAbs = resolve(dirname(absPath), path);
      const childId = bundleModule(childAbs);
      if (ns) {
        return `const ${ns} = ${childId};`;
      }
      if (named) {
        const items = named.split(',').map((s) => s.trim()).filter(Boolean)
          .map((s) => {
            const [a, b] = s.split(/\s+as\s+/).map((x) => x.trim());
            return b ? `${a}: ${b}` : a;
          })
          .join(', ');
        return `const { ${items} } = ${childId};`;
      }
      if (def) {
        return `const ${def} = ${childId}.default;`;
      }
      return '';
    },
  );

  // export function foo  →  function foo  + 末尾で exports に集約
  const exported = [];
  code = code.replace(/export\s+(async\s+)?function\s+(\w+)/g, (_, asyncKw, n) => {
    exported.push(n); return `${asyncKw ?? ''}function ${n}`;
  });
  code = code.replace(/export\s+const\s+(\w+)/g, (_, n) => {
    exported.push(n); return `const ${n}`;
  });
  code = code.replace(/export\s+let\s+(\w+)/g, (_, n) => {
    exported.push(n); return `let ${n}`;
  });
  code = code.replace(/export\s+class\s+(\w+)/g, (_, n) => {
    exported.push(n); return `class ${n}`;
  });
  // export { a, b as c };
  code = code.replace(/export\s+\{([^}]+)\}\s*;?/g, (_, list) => {
    list.split(',').forEach((p) => {
      const [a, b] = p.split(/\s+as\s+/).map((x) => x.trim());
      exported.push(b ? `${b}: ${a}` : a);
    });
    return '';
  });

  const wrapped = `// === ${relative(srcDir, absPath)} ===\nconst ${exportsId} = (() => {\n${code}\n  return { ${exported.join(', ')} };\n})();\n`;
  moduleCache.get(absPath).code = wrapped;
  order.push(absPath);
  return exportsId;
}

bundleModule(entryJs);
const bundledJs = order.map((p) => moduleCache.get(p).code).join('\n');

// --- HTML を読み、CSS / JS をインライン化 ---

let html = readFileSync(entryHtml, 'utf8');
const cssPath = resolve(srcDir, 'css/app.css');
const css = readFileSync(cssPath, 'utf8');

// `$$` のような sequence がコールバック内では特殊解釈されないよう、関数形式で置換する。
html = html.replace(
  /<link\s+rel="stylesheet"\s+href="css\/app\.css"\s*\/?>/,
  () => `<style>\n${css}\n</style>`,
);
html = html.replace(
  /<script\s+type="module"\s+src="js\/app\.js"\s*><\/script>/,
  () => `<script>\n${bundledJs}\n</script>`,
);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html, 'utf8');
console.log('built:', relative(root, outFile), '(', html.length, 'bytes )');
