/**
 * A local fake ClickUp for real end-to-end checks of the pipeline (scripts/visible-agents-check.ps1): one list L1 and
 * one task T1, comments and status kept in memory, every request printed. The kit talks to it through
 * TOSSANA_CLICKUP_API_URL=http://127.0.0.1:<port>/api (only localhost URLs are accepted). Usage: node fake-clickup.mjs [port]
 */
import { createServer } from 'node:http';
const statuses = ['to do', 'coding', 'in review', 'testing', 'ready for review', 'complete'].map((s) => ({
  status: s,
  type: s === 'complete' ? 'closed' : s === 'to do' ? 'open' : 'custom',
}));
const task = {
  id: 'T1',
  name: 'Add a sum function',
  status: 'to do',
  description: 'Create src/sum.js exporting sum(a, b) that returns a + b. Keep it tiny.',
};
const comments = [];
const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/api/, '');
    const key = `${req.method} ${path}`;
    console.log(key);
    if (key === 'GET /v2/user') return send(res, 200, { user: { id: 777, username: 'owner' } });
    if (key === 'GET /v2/list/L1') return send(res, 200, { id: 'L1', name: 'Probe', statuses });
    if (key === 'GET /v2/task/T1')
      return send(res, 200, {
        id: 'T1',
        name: task.name,
        description: task.description,
        markdown_description: task.description,
        status: { status: task.status, type: 'custom' },
        list: { id: 'L1' },
      });
    if (key === 'PUT /v2/task/T1') {
      task.status = JSON.parse(body).status;
      console.log('  status ->', task.status);
      return send(res, 200, {});
    }
    if (key === 'GET /v2/task/T1/comment') return send(res, 200, { comments: [...comments].reverse() });
    if (key === 'POST /v2/task/T1/comment') {
      const id = String(comments.length + 1);
      const text = JSON.parse(body).comment_text;
      comments.push({ id, date: String(Date.now()), comment_text: text, user: { id: 777, username: 'owner' } });
      console.log('  comment:', text.split('\n')[0]);
      return send(res, 200, { id });
    }
    if (key.startsWith('GET /v2/list/L1/task')) return send(res, 200, { tasks: [], last_page: true });
    send(res, 404, { err: `no fake route ${key}` });
  });
}).listen(Number(process.argv[2] ?? 47811), '127.0.0.1');
