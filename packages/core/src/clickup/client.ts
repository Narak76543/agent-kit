/**
 * Typed ClickUp REST client (API v2, plus v3 for Docs). Ported from EKMONG_MOBILE
 * scripts/clickup.ts. All requests go through the RateLimiter; setStatus always runs the
 * Done guard. The token is sent only in the Authorization header and never logged.
 */
import { ClickUpApiError, ConfigError, KitError } from '../errors.js';
import { silentLogger, type Logger } from '../logger.js';
import { assertStatusNameAllowed, assertStatusTypeAllowed } from './guard.js';
import { RateLimiter, type RateLimiterOptions } from './rate-limiter.js';
import type {
  ClickUpComment,
  ClickUpDocPage,
  ClickUpFolder,
  ClickUpList,
  ClickUpSpace,
  ClickUpStatus,
  ClickUpTask,
  ClickUpTeam,
  ClickUpUser,
} from './types.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const CLICKUP_API_URL = 'https://api.clickup.com/api';

/** Used when no statuses are configured: the team-wide defaults from the plan. */
export const DEFAULT_AGENT_STATUSES = ['to do', 'coding', 'in review', 'testing', 'ready for review'] as const;

/** ClickUp returns at most 25 comments per page. */
const COMMENTS_PAGE_SIZE = 25;

export interface ClickUpClientOptions {
  token: string;
  /** Workspace (team) ID. Needed for custom task IDs and Docs. */
  workspaceId?: string;
  /** Treat task IDs as custom IDs (e.g. "EKM-12"). Needs workspaceId. */
  customTaskIds?: boolean;
  /** Status names agents may set (the guard's allow-list). */
  agentStatuses?: readonly string[];
  fetch?: FetchLike;
  baseUrl?: string;
  limiter?: RateLimiter | RateLimiterOptions;
  logger?: Logger;
}

type Query = Record<string, string | number | boolean | (string | number)[] | undefined>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  version?: 'v2' | 'v3';
}

export interface StatusChange {
  taskId: string;
  from: string | null;
  to: string;
}

export class ClickUpClient {
  readonly agentStatuses: readonly string[];
  private readonly token: string;
  private readonly workspaceId: string | undefined;
  private readonly customTaskIds: boolean;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private readonly limiter: RateLimiter;
  private readonly logger: Logger;

  constructor(options: ClickUpClientOptions) {
    if (!options.token?.trim()) throw new ConfigError('CLICKUP_API_TOKEN is missing. Add it to .env');
    if (options.customTaskIds && !options.workspaceId) {
      throw new ConfigError('CLICKUP_CUSTOM_TASK_IDS=true needs CLICKUP_WORKSPACE_ID in .env');
    }
    this.token = options.token.trim();
    this.workspaceId = options.workspaceId || undefined;
    this.customTaskIds = options.customTaskIds ?? false;
    this.agentStatuses = options.agentStatuses?.length ? options.agentStatuses : DEFAULT_AGENT_STATUSES;
    this.fetchFn = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.baseUrl = (options.baseUrl ?? CLICKUP_API_URL).replace(/\/+$/, '');
    this.logger = options.logger ?? silentLogger;
    this.logger.addSecret(this.token);
    this.limiter =
      options.limiter instanceof RateLimiter
        ? options.limiter
        : new RateLimiter({
            onWait: (w) =>
              this.logger.warn(
                w.reason === 'budget'
                  ? `[clickup] rate limit nearly used, waiting ${Math.ceil(w.ms / 1000)}s`
                  : `[clickup] ${w.status ? `HTTP ${w.status}` : 'network error'}, retry ${w.attempt} in ${Math.ceil(w.ms / 1000)}s`,
              ),
            ...options.limiter,
          });
  }

  // ---------- tasks ----------

  getTask(taskId: string, options: { subtasks?: boolean } = {}): Promise<ClickUpTask> {
    return this.request('GET', `/task/${enc(taskId)}`, {
      query: { ...this.taskQuery(), include_subtasks: options.subtasks ?? true, include_markdown_description: true },
    });
  }

  /** All comments on a task, oldest first. */
  async getComments(taskId: string): Promise<ClickUpComment[]> {
    const all: ClickUpComment[] = [];
    const seen = new Set<string>();
    // Newest first, 25 at a time; page backwards with `start` + `start_id` from the last comment.
    let query: Query = this.taskQuery();
    for (;;) {
      const page = await this.request<{ comments?: ClickUpComment[] }>('GET', `/task/${enc(taskId)}/comment`, {
        query,
      });
      const comments = page.comments ?? [];
      const fresh = comments.filter((c) => !seen.has(String(c.id)));
      if (!fresh.length) break;
      for (const c of fresh) seen.add(String(c.id));
      all.push(...fresh);
      if (comments.length < COMMENTS_PAGE_SIZE) break;
      const last = comments[comments.length - 1]!;
      query = { ...this.taskQuery(), start: String(last.date), start_id: String(last.id) };
    }
    return all.reverse();
  }

  async postComment(
    taskId: string,
    text: string,
    options: { assignee?: number; notifyAll?: boolean } = {},
  ): Promise<{ id: string }> {
    if (!text.trim()) throw new KitError('comment text is empty');
    const body: Record<string, unknown> = { comment_text: text, notify_all: options.notifyAll ?? false };
    if (options.assignee !== undefined) body.assignee = options.assignee;
    const res = await this.request<{ id: string | number }>('POST', `/task/${enc(taskId)}/comment`, {
      query: this.taskQuery(),
      body,
    });
    return { id: String(res.id) };
  }

  /** A comment assigned to the owner, so it shows in their notifications and "Assigned comments". */
  async notify(taskId: string, text: string, ownerUserId: string | number): Promise<{ id: string }> {
    const owner = Number(ownerUserId);
    if (!Number.isInteger(owner) || owner <= 0) {
      throw new ConfigError('CLICKUP_OWNER_USER_ID is missing or not a number in .env');
    }
    return this.postComment(taskId, text, { assignee: owner, notifyAll: true });
  }

  /**
   * Moves a task to `status` (an exact ClickUp status name). Runs the Done guard:
   * name checks before any request, then the list's real status type.
   */
  async setStatus(taskId: string, status: string): Promise<StatusChange> {
    assertStatusNameAllowed(status, this.agentStatuses);

    const task = await this.getTask(taskId, { subtasks: false });
    if (!task.list?.id) throw new KitError(`task ${taskId} has no list`);
    const list = await this.getList(task.list.id);
    const wanted = status.trim().toLowerCase();
    const match = (list.statuses ?? []).find((s) => s.status.trim().toLowerCase() === wanted);
    if (!match) {
      throw new KitError(`status "${status}" does not exist on list "${list.name}" [${list.id}]`);
    }
    assertStatusTypeAllowed(match);

    await this.request('PUT', `/task/${enc(taskId)}`, { query: this.taskQuery(), body: { status: match.status } });
    return { taskId, from: task.status?.status ?? null, to: match.status };
  }

  async createSubtask(parentTaskId: string, name: string, description = ''): Promise<ClickUpTask> {
    if (!name.trim()) throw new KitError('subtask name is empty');
    const parent = await this.getTask(parentTaskId, { subtasks: false });
    if (!parent.list?.id) throw new KitError(`task ${parentTaskId} has no list`);
    return this.request('POST', `/list/${enc(parent.list.id)}/task`, {
      body: { name, markdown_description: description, parent: parent.id },
    });
  }

  /** All tasks in a list (every page), optionally filtered by exact status names and assignee IDs. */
  async getListTasks(
    listId: string,
    filter: { statuses?: string[]; assignees?: (string | number)[]; subtasks?: boolean } = {},
  ): Promise<ClickUpTask[]> {
    const tasks: ClickUpTask[] = [];
    for (let page = 0; ; page++) {
      const res = await this.request<{ tasks?: ClickUpTask[]; last_page?: boolean }>(
        'GET',
        `/list/${enc(listId)}/task`,
        {
          query: {
            page,
            subtasks: filter.subtasks ?? false,
            order_by: 'created',
            reverse: true,
            'statuses[]': filter.statuses,
            'assignees[]': filter.assignees,
          },
        },
      );
      tasks.push(...(res.tasks ?? []));
      if (res.last_page !== false || !res.tasks?.length) break;
    }
    return tasks;
  }

  // ---------- lists, workspaces, user ----------

  getList(listId: string): Promise<ClickUpList> {
    return this.request('GET', `/list/${enc(listId)}`);
  }

  async getListStatuses(listId: string): Promise<ClickUpStatus[]> {
    return (await this.getList(listId)).statuses ?? [];
  }

  /** The user who owns the token. Also a cheap way to check the token works. */
  async getUser(): Promise<ClickUpUser> {
    return (await this.request<{ user: ClickUpUser }>('GET', '/user')).user;
  }

  async getWorkspaces(): Promise<ClickUpTeam[]> {
    return (await this.request<{ teams?: ClickUpTeam[] }>('GET', '/team')).teams ?? [];
  }

  async getSpaces(workspaceId: string): Promise<ClickUpSpace[]> {
    return (
      (
        await this.request<{ spaces?: ClickUpSpace[] }>('GET', `/team/${enc(workspaceId)}/space`, {
          query: { archived: false },
        })
      ).spaces ?? []
    );
  }

  async getFolders(spaceId: string): Promise<ClickUpFolder[]> {
    return (
      (
        await this.request<{ folders?: ClickUpFolder[] }>('GET', `/space/${enc(spaceId)}/folder`, {
          query: { archived: false },
        })
      ).folders ?? []
    );
  }

  /** Lists directly in a space (not inside a folder). */
  async getFolderlessLists(spaceId: string): Promise<ClickUpList[]> {
    return (
      (
        await this.request<{ lists?: ClickUpList[] }>('GET', `/space/${enc(spaceId)}/list`, {
          query: { archived: false },
        })
      ).lists ?? []
    );
  }

  // ---------- docs (API v3) ----------

  /** All pages of a ClickUp Doc, nested, with markdown content. */
  async getDocPages(docId: string): Promise<ClickUpDocPage[]> {
    if (!this.workspaceId) throw new ConfigError('CLICKUP_WORKSPACE_ID is missing in .env (needed for ClickUp Docs)');
    const res = await this.request<ClickUpDocPage[] | { pages?: ClickUpDocPage[] }>(
      'GET',
      `/workspaces/${enc(this.workspaceId)}/docs/${enc(docId)}/pages`,
      { version: 'v3', query: { max_page_depth: -1, content_format: 'text/md' } },
    );
    return Array.isArray(res) ? res : (res.pages ?? []);
  }

  // ---------- HTTP ----------

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}/${options.version ?? 'v2'}${path}${toQueryString(options.query)}`;
    const init: RequestInit = {
      method,
      headers: { Authorization: this.token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    };

    let res: Response;
    try {
      res = await this.limiter.run(() => this.fetchFn(url, init));
    } catch (e) {
      throw new KitError(this.logger.redact(`network error on ${method} ${path}: ${(e as Error).message}`));
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    if (!res.ok) throw new ClickUpApiError(res.status, method, path, data);
    return data as T;
  }

  private taskQuery(): Query {
    return this.customTaskIds ? { custom_task_ids: true, team_id: this.workspaceId } : {};
  }
}

const enc = (s: string) => encodeURIComponent(s);

function toQueryString(query: Query | undefined): string {
  if (!query) return '';
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) q.append(key, String(v));
    else q.set(key, String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
