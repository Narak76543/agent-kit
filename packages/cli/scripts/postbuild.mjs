// Runs after tsup: bundles the templates into this package and writes the JSON Schema for
// agent.config.json (generated from the zod schema in @tossana/agents-core).
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
console.log('postbuild: copied templates, wrote schema/agent.config.schema.json');
