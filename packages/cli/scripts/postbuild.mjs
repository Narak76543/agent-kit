// Runs after tsup: bundles the templates into this package, writes the JSON Schema for
// agent.config.json (generated from the zod schema in @tossana/agents-core) and builds the Local Console page.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configJsonSchema } from '@tossana/agents-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const templates = join(root, 'templates');
rmSync(templates, { recursive: true, force: true });
cpSync(join(root, '..', 'templates'), templates, {
  recursive: true,
  filter: (src) => !['package.json', 'README.md', 'node_modules'].includes(basename(src)),
});

mkdirSync(join(root, 'schema'), { recursive: true });
writeFileSync(join(root, 'schema', 'agent.config.schema.json'), `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
// Local Console: one self-contained HTML file (script, styles and design tokens inline; the server adds a CSP
// nonce per response). No runtime dependencies and nothing loaded from other origins.
const web = join(root, 'src', 'console', 'web');
const bundle = await build({
  entryPoints: [join(web, 'main.ts')],
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  legalComments: 'none',
});
const script = bundle.outputFiles[0].text.replace(/<\/(script)/gi, '<\\/$1');
const tokens = readFileSync(createRequire(import.meta.url).resolve('@tossana/design-tokens/tokens.css'), 'utf8');
const page = readFileSync(join(web, 'index.html'), 'utf8')
  .replace('/*TOKENS*/', () => tokens)
  .replace('/*STYLES*/', () => readFileSync(join(web, 'console.css'), 'utf8'))
  .replace('/*SCRIPT*/', () => script);
writeFileSync(join(root, 'dist', 'console.html'), page);

console.log(
  `postbuild: copied templates, wrote schema/agent.config.schema.json, dist/console.html (${Math.round(page.length / 1024)} KB)`,
);
