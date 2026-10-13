/**
 * The Local Console's HTTP server: 127.0.0.1 only, random port, every request checked (see security.ts) before
 * any route runs. JSON in and out; every string in a response is redacted. The live log is newline-delimited
 * JSON over a streamed response (fetch can send the Authorization header; EventSource cannot).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KitError, clickUpErrorHint } from '@tossana/agents-core';
import { ConsoleError, type ConsoleApp, type RunEvent } from './app.js';
import { checkRequest, newNonce, newSessionToken, securityHeaders } from './security.js';

const MAX_BODY_BYTES = 64 * 1024;
export const NONCE_PLACEHOLDER = '__CSP_NONCE__';

export interface ConsoleServer {
  port: number;
  token: string;
  /** The URL to open (contains the session token). */
  url: string;
  close(): Promise<void>;
}

export async function startConsoleServer(options: {
  app: ConsoleApp;
  /** The page; NONCE_PLACEHOLDER is replaced by a fresh CSP nonce per response. */
  html: string;
  /** Tests only: a fixed port. Default: a random free port chosen by the OS. */
  port?: number;
}): Promise<ConsoleServer> {
  const { app, html } = options;
  const token = newSessionToken();
  let port = 0;
  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => sendError(res, e));
  });

  const send = (res: ServerResponse, status: number, data: unknown) => {
    // Redact every string before serialising, so an escaped secret can never slip through.
    const body = JSON.stringify(data, (_k, v: unknown) => (typeof v === 'string' ? app.redact(v) : v));
    res.writeHead(status, { ...securityHeaders(), 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  const sendError = (res: ServerResponse, e: unknown) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (e instanceof ConsoleError) return send(res, e.status, { error: e.message, ...e.extra });
    if (e instanceof KitError) return send(res, 400, { error: e.message, fix: clickUpErrorHint(e) });
    return send(res, 500, { error: (e as Error)?.message ?? String(e) });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const check = checkRequest(req, port, token);
    if (!check.ok) {
      req.resume();
      return send(res, check.status, { error: check.error });
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const route = `${req.method} ${url.pathname}`;

    switch (route) {
      case 'GET /': {
        const nonce = newNonce();
        res.writeHead(200, { ...securityHeaders(nonce), 'content-type': 'text/html; charset=utf-8' });
        res.end(html.replaceAll(NONCE_PLACEHOLDER, nonce));
        return;
      }
      case 'GET /api/project':
        return send(res, 200, app.project());
      case 'GET /api/doctor':
        return send(res, 200, await app.doctor());
      case 'GET /api/tasks':
        return send(res, 200, await app.tasks());
      case 'POST /api/preview':
        return send(res, 200, await app.preview(await readJson(req)));
      case 'POST /api/runs':
        return send(res, 200, app.start(await readJson(req)));
      case 'POST /api/runs/stop':
        await readJson(req);
        return send(res, 200, app.stop());
      case 'GET /api/runs/current':
        return send(res, 200, { run: app.currentRun() });
      case 'GET /api/runs/current/status':
        return send(res, 200, await app.runStatus());
      case 'GET /api/runs/current/stream':
        return stream(req, res, Number(url.searchParams.get('from') ?? 0) || 0);
      default:
        return send(res, 404, { error: 'not found' });
    }
  }

  function stream(req: IncomingMessage, res: ServerResponse, from: number) {
    const write = (e: RunEvent) => {
      res.write(`${JSON.stringify(e)}\n`);
      if (e.type === 'state' && e.state !== 'running') res.end();
    };
    res.writeHead(200, { ...securityHeaders(), 'content-type': 'application/x-ndjson; charset=utf-8' });
    // Lines are redacted when the run records them (RunSession), before they are stored.
    const unsubscribe = app.subscribe(from, write);
    req.on('close', unsubscribe);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/?token=${token}`,
    close: async () => {
      await app.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ConsoleError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConsoleError(400, 'invalid JSON');
  }
}
