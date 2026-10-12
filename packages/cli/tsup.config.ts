import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // core is not published: bundle it, so the CLI is the only package people install.
  // Its own dependencies (zod) are listed in the CLI's package.json.
  noExternal: ['@tossana/agents-core'],
});
