/**
 * For people, not agents:
 *   tossana-agents review <taskId>               look at a finished task, then push it, send feedback, or skip
 *   tossana-agents feedback <taskId> "text"      send a task back to the coder with your comment
 *   tossana-agents worktrees list | clean [taskId] [--force]
 * review refuses to run without an interactive terminal or inside an agent run (TOSSANA_AGENT is set for agent
 * processes). Setting Done stays manual in ClickUp.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { KitError, isClosedType, isValidTaskId, parseAgentComment } from '@tossana/agents-core';
import { createClient, loadProject, requireConfig, type CliContext } from '../context.js';
import { versionOf } from '../exec.js';
import { sendFeedback } from '../feedback.js';
import { TMP_DIR } from '../paths.js';
import { clackPrompts, type Prompts } from '../prompts.js';
import { splitCommand } from '../runners.js';
import { listWorktrees, removeWorktree, worktreePath } from '../worktrees.js';

const GATE_TIMEOUT_MS = 15 * 60_000;

export function registerReviewCommands(program: Command, ctx: CliContext, prompts: Prompts = clackPrompts): void {
  const print = (s: string) => ctx.logger.info(s);

  program
    .command('feedback <taskId> <text...>')
    .description('send a task back to the coder: posts your comment and moves the task to coding (watch resumes it)')
    .action(async (taskId: string, words: string[]) => {
      const project = loadProject(ctx);
      const config = requireConfig(project);
      const r = await sendFeedback(ctx.cwd, config, createClient(ctx, project), taskId, words.join(' '), ctx.now());
      print(`Posted your comment on ${taskId} and moved it to "${r.status}".`);
      print(
        'watch resumes it with your comment first. Without watch: tossana-agents run --task ' + `${taskId} --resume`,
      );
    });

  program
    .command('review <taskId>')
    .description('review a finished task (people only): summary, checks, diff in VS Code, then push / feedback / skip')
    .action(async (taskId: string) => {
      if (!ctx.io.interactive || ctx.processEnv.TOSSANA_AGENT) {
        throw new KitError('review is for people: run it yourself in a terminal (agents cannot use it).');
      }
      if (!isValidTaskId(taskId)) throw new KitError(`invalid task id "${taskId}"`);
      const ask = ctx.prompts ?? prompts;
      const project = loadProject(ctx);
      const config = requireConfig(project);
      const client = createClient(ctx, project);
      const base = config.pipeline.baseBranch;
      const branch = `${config.pipeline.branchPrefix}${taskId}`;
      const git = (args: string[], cwd = ctx.cwd) => {
        const r = ctx.exec('git', args, { cwd, timeoutMs: 120_000 });
        return { ok: r.code === 0, out: r.stdout.trim(), err: (r.stderr || r.error?.message || '').trim() };
      };
      if (!git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok)
        throw new KitError(`there is no branch ${branch} here.`);

      // ---------- what the agents say ----------
      const [task, comments] = await Promise.all([
        client.getTask(taskId, { subtasks: false }),
        client.getComments(taskId),
      ]);
      if (isClosedType(task.status?.type)) throw new KitError(`${taskId} is closed ("${task.status?.status}").`);
      const agentComments = comments.map((c) => parseAgentComment(c.comment_text ?? '')).filter((c) => c !== null);
      const final = agentComments.at(-1);
      const rounds = Math.max(0, ...agentComments.map((c) => c.round ?? 0));
      print(`\n${task.name} (${taskId}) — ${task.status?.status ?? '?'}${task.url ? `\n${task.url}` : ''}`);
      print(
        `Rounds: ${rounds}${final ? ` · last: ${final.agent} ${final.result}${final.by ? ` · ${final.by}` : ''}` : ''}`,
      );
      if (final?.summary) print(`Summary: ${final.summary}`);
      for (const i of final?.issues ?? []) print(`  - ${i.location ? `${i.location} - ` : ''}${i.text}`);

      // ---------- quality gate, in the task's worktree ----------
      const wt = worktreePath(ctx.cwd, taskId);
      const gate = (['lint', 'typecheck', 'test'] as const).flatMap((k) =>
        config.commands[k]?.trim() ? [config.commands[k]!.trim()] : [],
      );
      if (!existsSync(wt)) {
        print(`\nQuality gate: skipped (no worktree at ${wt}; the agents' own results are above).`);
      } else if (gate.length) {
        print('\nQuality gate (in the task worktree):');
        for (const command of gate) {
          const [cmd, ...args] = splitCommand(command);
          const r = ctx.exec(cmd!, args, { cwd: wt, timeoutMs: GATE_TIMEOUT_MS });
          print(`  ${r.code === 0 ? '✓' : '✗'} ${command}`);
          if (r.code !== 0) {
            const tail = (r.stdout + r.stderr || r.error?.message || '').trim().split(/\r?\n/).slice(-6);
            for (const line of tail) print(`      ${line}`);
          }
        }
      }

      // ---------- the diff ----------
      const stat = git(['diff', '--stat', `${base}...${branch}`]);
      print(`\nChanges (${base}...${branch}):\n${stat.out || '(no changes)'}`);
      const diff = git(['diff', `${base}...${branch}`]);
      const diffFile = join(ctx.cwd, ...TMP_DIR.split('/'), `review-${taskId}.diff`);
      mkdirSync(join(ctx.cwd, ...TMP_DIR.split('/')), { recursive: true });
      writeFileSync(diffFile, `${diff.out}\n`);
      const opened = ctx.exec('code', [diffFile], { timeoutMs: 20_000 });
      print(
        opened.code === 0
          ? `Opened the diff in VS Code (${diffFile}).`
          : `Diff: ${diffFile} (VS Code's "code" command was not found).`,
      );

      // ---------- what now ----------
      const choice = await ask.select(
        'What now?',
        [
          {
            value: 'push',
            label: `Push ${branch}${versionOf(ctx.exec, 'gh', ctx.cwd) ? ' (and open a pull request)' : ''}`,
          },
          { value: 'feedback', label: 'Send it back to coding with my comment' },
          { value: 'skip', label: 'Skip for now' },
        ],
        'skip',
      );
      if (choice === 'push') {
        const push = git(['push', '-u', 'origin', branch]);
        if (!push.ok) throw new KitError(`git push failed: ${push.err}`);
        print(`Pushed ${branch}.`);
        if (versionOf(ctx.exec, 'gh', ctx.cwd) && (await ask.confirm('Open a pull request with gh?', true))) {
          const body = `${final?.summary ?? ''}\n\nClickUp: ${task.url ?? taskId}\n\nMade with tossana-agents.`;
          const pr = ctx.exec(
            'gh',
            ['pr', 'create', '--head', branch, '--base', base, '--title', task.name, '--body', body],
            {
              cwd: ctx.cwd,
              timeoutMs: 120_000,
            },
          );
          print(
            pr.code === 0
              ? `Pull request: ${pr.stdout.trim()}`
              : `gh pr create failed: ${(pr.stderr || pr.stdout).trim()}`,
          );
        }
      } else if (choice === 'feedback') {
        const text = await ask.text('Your feedback for the coder (it becomes the top-priority instruction)');
        const r = await sendFeedback(ctx.cwd, config, client, taskId, text, ctx.now());
        print(`Posted your comment and moved ${taskId} to "${r.status}". watch picks it up.`);
      }
      print('Setting the task to Done stays manual, in ClickUp.');
    });

  const wt = program.command('worktrees').description('the task worktrees next to this folder (<repo>-tasks/<taskId>)');
  wt.command('list', { isDefault: true })
    .description('every task worktree: branch, commits ahead, uncommitted changes, ClickUp status')
    .action(async () => {
      const project = loadProject(ctx);
      const config = requireConfig(project);
      const list = listWorktrees(ctx, config);
      if (!list.length) {
        print('No task worktrees.');
        return;
      }
      const client = createClient(ctx, project);
      for (const w of list) {
        const status = await client.getTask(w.taskId, { subtasks: false }).then(
          (t) => t.status?.status ?? '?',
          () => '?',
        );
        print(
          `${w.taskId.padEnd(14)} ${String(w.branch).padEnd(22)} ${status.padEnd(18)} ` +
            `${w.ahead} commit(s)${w.dirty ? ', UNCOMMITTED changes' : ''}  ${w.path}`,
        );
      }
    });
  wt.command('clean [taskId]')
    .description('remove finished worktrees (closed in ClickUp or merged, nothing uncommitted); branches are kept')
    .option('--force', 'also remove one with uncommitted changes (only with a task id)')
    .action(async (taskId: string | undefined, opts: { force?: boolean }) => {
      const project = loadProject(ctx);
      const config = requireConfig(project);
      const list = listWorktrees(ctx, config);
      if (taskId) {
        const w = list.find((x) => x.taskId === taskId);
        if (!w) throw new KitError(`no worktree for ${taskId}`);
        removeWorktree(ctx, w, opts.force);
        print(`Removed ${w.path} (branch ${w.branch} kept).`);
        return;
      }
      const client = createClient(ctx, project);
      let removed = 0;
      for (const w of list) {
        if (w.dirty) continue;
        const closed = await client.getTask(w.taskId, { subtasks: false }).then(
          (t) => isClosedType(t.status?.type),
          () => false,
        );
        if (!closed && !w.merged) continue;
        removeWorktree(ctx, w);
        print(`Removed ${w.path} (${closed ? 'closed in ClickUp' : 'merged'}; branch ${w.branch} kept).`);
        removed++;
      }
      if (!removed)
        print('Nothing to clean: no worktree is both finished (closed or merged) and without uncommitted changes.');
    });
}
