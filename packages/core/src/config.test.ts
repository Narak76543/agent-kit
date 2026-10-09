import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentStatusNames,
  clickUpClientOptions,
  configJsonSchema,
  docsSettings,
  isRole,
  loadConfig,
  loadEnv,
  parseConfig,
  parseDotEnv,
  statusForRole,
  type AgentConfigInput,
} from './config.js';
import { ConfigError } from './errors.js';

const BOM = String.fromCharCode(0xfeff);

const MINIMAL: AgentConfigInput = {
  version: 1,
  project: { name: 'EKMONG_MOBILE', type: 'react-native', skill: 'mobile-master' },
  clickup: { listId: '901234567' },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tak-config-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseConfig', () => {
  it('fills defaults for a minimal config', () => {
    const c = parseConfig(MINIMAL);
    expect(c.clickup.statuses).toEqual({
      todo: 'to do',
      coding: 'coding',
      review: 'in review',
      testing: 'testing',
      human: 'ready for review',
    });
    expect(c.clickup.customTaskIds).toBe(false);
    expect(c.clickup.docs).toEqual({ ids: [], outDir: 'docs/clickup' });
    expect(c.commands).toEqual({});
    expect(c.pipeline).toEqual({
      maxRounds: 5,
      branchPrefix: 'task/',
      baseBranch: 'main',
      requireCleanGit: true,
      runner: 'opencode',
      timeoutMinutes: 120,
    });
  });

  it('accepts the full example from the plan', () => {
    const c = parseConfig({
      $schema: './node_modules/@tossana/agents/schema/agent.config.schema.json',
      ...MINIMAL,
      clickup: {
        listId: '901234567',
        statuses: {
          todo: 'to do',
          coding: 'coding',
          review: 'in review',
          testing: 'testing',
          human: 'ready for narak',
        },
      },
      commands: { install: 'pnpm install', lint: 'pnpm lint', typecheck: 'pnpm typecheck', test: 'pnpm test' },
      pipeline: { maxRounds: 3, branchPrefix: 'feat/', requireCleanGit: false, runner: 'custom' },
    });
    expect(c.clickup.statuses.human).toBe('ready for narak');
    expect(c.pipeline.runner).toBe('custom');
    expect(c.commands.test).toBe('pnpm test');
  });

  it('lists every problem with its path', () => {
    const err = (() => {
      try {
        parseConfig({ version: 2, project: { name: '', type: 'angular' }, clickup: {} });
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.message).toMatch(/^agent.config.json is not valid:/);
    for (const path of ['version', 'project.name', 'project.type', 'project.skill', 'clickup.listId']) {
      expect(err!.message).toContain(`  - ${path}:`);
    }
  });

  it('reports a non-object config at the root', () => {
    expect(() => parseConfig(null)).toThrow('(root)');
  });

  it.each(['done', 'Complete', 'closed'])('refuses a role mapped to a "%s" status', (name) => {
    expect(() => parseConfig({ ...MINIMAL, clickup: { listId: '1', statuses: { human: name } } })).toThrow(
      /clickup\.statuses\.human: agents could never set this status/,
    );
  });

  it('refuses two roles mapped to the same status', () => {
    expect(() => parseConfig({ ...MINIMAL, clickup: { listId: '1', statuses: { testing: 'In Review' } } })).toThrow(
      /clickup\.statuses\.testing: same status as "review"/,
    );
  });

  it('checks pipeline limits', () => {
    expect(() => parseConfig({ ...MINIMAL, pipeline: { maxRounds: 0 } })).toThrow(/pipeline\.maxRounds/);
    expect(() => parseConfig({ ...MINIMAL, pipeline: { runner: 'cursor' } })).toThrow(/pipeline\.runner/);
  });
});

describe('role helpers', () => {
  const c = parseConfig({ ...MINIMAL, clickup: { listId: '1', statuses: { human: 'Ready for Narak' } } });

  it('maps roles to status names', () => {
    expect(statusForRole(c, 'human')).toBe('Ready for Narak');
    expect(agentStatusNames(c)).toEqual(['to do', 'coding', 'in review', 'testing', 'Ready for Narak']);
  });

  it('recognises role names', () => {
    expect(isRole('review')).toBe(true);
    expect(isRole('in review')).toBe(false);
    expect(isRole('done')).toBe(false);
  });
});

describe('loadConfig', () => {
  it('reads agent.config.json, including one saved with a BOM by a Windows editor', () => {
    writeFileSync(join(dir, 'agent.config.json'), BOM + JSON.stringify(MINIMAL));
    expect(loadConfig(dir).project.name).toBe('EKMONG_MOBILE');
  });

  it('explains how to fix a missing file', () => {
    expect(() => loadConfig(dir)).toThrow(/agent.config.json not found .*Run: tossana-agents init/);
  });

  it('explains invalid JSON', () => {
    writeFileSync(join(dir, 'agent.config.json'), '{ "version": 1, }');
    expect(() => loadConfig(dir)).toThrow(/agent.config.json is not valid JSON/);
  });
});

describe('configJsonSchema', () => {
  it('describes the config for editors', () => {
    const schema = configJsonSchema() as {
      required: string[];
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['version', 'project', 'clickup']));
    expect(schema.properties.clickup!.properties).toHaveProperty('statuses');
    expect(schema.properties.pipeline!.properties).toHaveProperty('runner');
    expect(JSON.stringify(schema)).toContain('ready for review');
  });
});

describe('parseDotEnv', () => {
  it('parses values like the original script, plus comments, quotes, export and CRLF', () => {
    const env = parseDotEnv(
      BOM +
        '# comment\r\nCLICKUP_API_TOKEN=pk_1_abc\r\nexport CLICKUP_OWNER_USER_ID = "123" \r\n' +
        'AGENT_CMD=\'opencode run --agent {agent} "{prompt}"\'\r\nEMPTY=\r\nWITH_COMMENT=abc # note\r\nnot a line\r\n',
    );
    expect(env).toEqual({
      CLICKUP_API_TOKEN: 'pk_1_abc',
      CLICKUP_OWNER_USER_ID: '123',
      AGENT_CMD: 'opencode run --agent {agent} "{prompt}"',
      EMPTY: '',
      WITH_COMMENT: 'abc',
    });
  });

  it('keeps # inside quotes', () => {
    expect(parseDotEnv('A="x # y"')).toEqual({ A: 'x # y' });
  });
});

describe('loadEnv', () => {
  it('reads .env and lets real environment variables win', () => {
    writeFileSync(join(dir, '.env'), 'CLICKUP_API_TOKEN=from-file\nCLICKUP_OWNER_USER_ID=1\n');
    const env = loadEnv(dir, { CLICKUP_OWNER_USER_ID: '2', EMPTY_VAR: '' });
    expect(env.CLICKUP_API_TOKEN).toBe('from-file');
    expect(env.CLICKUP_OWNER_USER_ID).toBe('2');
    expect(env.EMPTY_VAR).toBeUndefined();
  });

  it('works without a .env file', () => {
    expect(loadEnv(dir, {})).toEqual({});
  });
});

describe('clickUpClientOptions', () => {
  const c = parseConfig({ ...MINIMAL, clickup: { listId: '1', workspaceId: 'W1', customTaskIds: true } });

  it('combines config and env', () => {
    expect(clickUpClientOptions(c, { CLICKUP_API_TOKEN: 'pk_x' })).toEqual({
      token: 'pk_x',
      workspaceId: 'W1',
      customTaskIds: true,
      agentStatuses: ['to do', 'coding', 'in review', 'testing', 'ready for review'],
    });
  });

  it('lets .env override workspace and custom ID settings (EKMONG_MOBILE .env compatibility)', () => {
    const o = clickUpClientOptions(c, { CLICKUP_WORKSPACE_ID: 'W2', CLICKUP_CUSTOM_TASK_IDS: 'false' });
    expect(o).toMatchObject({ token: '', workspaceId: 'W2', customTaskIds: false });
  });
});

describe('docsSettings', () => {
  const c = parseConfig({ ...MINIMAL, clickup: { listId: '1', docs: { ids: ['d1'] } } });

  it('uses the config by default', () => {
    expect(docsSettings(c, {})).toEqual({ ids: ['d1'], outDir: 'docs/clickup' });
  });

  it('lets .env override doc IDs and output folder', () => {
    expect(docsSettings(c, { CLICKUP_DOC_IDS: ' a, b ,,', CLICKUP_DOCS_OUT: 'specs' })).toEqual({
      ids: ['a', 'b'],
      outDir: 'specs',
    });
  });
});
