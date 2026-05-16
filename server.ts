#!/usr/bin/env node
// Gemini Nano -> OpenAI-compatible local server.
// Spawns a headless Chrome that hosts the on-device model via the Prompt API
// and bridges it to an OpenAI-shaped HTTP endpoint. Run with: node server.ts

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const PORT = Number(process.env.NANO_PORT ?? 8765);
const CHROME = process.env.NANO_CHROME ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UDD = process.env.NANO_CHROME_UDD ?? join(import.meta.dirname, 'chrome-profile');
const MODEL = 'gemini-nano';

type Msg = { role: string; content: string };
type Job = { chunk: (s: string) => void; done: (err?: string) => void };

let bridge: ServerResponse | null = null;   // SSE connection to the in-Chrome page
let ready = false;
const jobs = new Map<string, Job>();

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const body = (req: IncomingMessage): Promise<any> =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });

const json = (res: ServerResponse, code: number, obj: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(obj));
};

// OpenAI content can be a string or an array of {text} parts.
const text = (c: any): string =>
  typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
  : c == null ? '' : String(c);

async function chat(req: IncomingMessage, res: ServerResponse) {
  const b = await body(req);
  if (!bridge || !ready) return json(res, 503, { error: { message: 'Gemini Nano not ready' } });

  const messages: Msg[] = (b.messages ?? []).map((m: any) => ({
    role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
    content: text(m.content),
  }));
  if (!messages.length) return json(res, 400, { error: { message: 'messages[] required' } });

  const id = 'chatcmpl-' + Date.now();
  const created = Math.floor(Date.now() / 1000);
  const timer = setTimeout(() => jobs.get(id)?.done('timed out after 180s'), 180_000);

  if (b.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache',
      connection: 'keep-alive', 'access-control-allow-origin': '*',
    });
    const send = (delta: object, finish: string | null) =>
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created,
        model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send({ role: 'assistant' }, null);
    jobs.set(id, {
      chunk: (s) => send({ content: s }, null),
      done: (err) => {
        clearTimeout(timer);
        send({}, err ? 'error' : 'stop');
        res.write('data: [DONE]\n\n');
        res.end();
        jobs.delete(id);
      },
    });
  } else {
    let acc = '';
    jobs.set(id, {
      chunk: (s) => { acc += s; },
      done: (err) => {
        clearTimeout(timer);
        jobs.delete(id);
        if (err) return json(res, 500, { error: { message: err } });
        json(res, 200, { id, object: 'chat.completion', created, model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: acc }, finish_reason: 'stop' }] });
      },
    });
  }
  bridge.write(`data: ${JSON.stringify({ id, messages })}\n\n`);
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const get = req.method === 'GET', post = req.method === 'POST';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*',
      'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
    return res.end();
  }

  // --- in-Chrome bridge page + channel ---
  if (pathname === '/bridge' && get) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(readFileSync(join(import.meta.dirname, 'bridge.html')));
  }
  if (pathname === '/bridge/events' && get) {
    res.writeHead(200, { 'content-type': 'text/event-stream',
      'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    bridge = res;
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => { clearInterval(ping); if (bridge === res) bridge = null; });
    return;
  }
  if (pathname === '/bridge/hello' && post) {
    const b = await body(req);
    ready = b.availability === 'available';
    log('bridge:', b.availability, ready ? '— READY' : '');
    return json(res, 200, { ok: true });
  }
  if (pathname === '/bridge/chunk' && post) {
    const b = await body(req);
    jobs.get(b.id)?.chunk(b.delta ?? '');
    return json(res, 200, { ok: true });
  }
  if (pathname === '/bridge/done' && post) {
    const b = await body(req);
    jobs.get(b.id)?.done(b.error);
    return json(res, 200, { ok: true });
  }
  if (pathname === '/bridge/log' && post) {
    log('[chrome]', (await body(req)).line ?? '');
    return json(res, 200, { ok: true });
  }

  // --- OpenAI-compatible API ---
  if (pathname === '/v1/models' && get) {
    return json(res, 200, { object: 'list',
      data: [{ id: MODEL, object: 'model', owned_by: 'google-chrome-on-device' }] });
  }
  if (pathname === '/v1/chat/completions' && post) return chat(req, res);
  if (pathname === '/healthz' || pathname === '/') {
    return json(res, 200, { service: 'nano-openai', model: MODEL, ready, bridge: !!bridge });
  }
  json(res, 404, { error: { message: 'not found: ' + pathname } });
});

server.listen(PORT, () => {
  log(`nano-openai on http://localhost:${PORT} — launching headless Chrome...`);
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--user-data-dir=${UDD}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--enable-features=OptimizationGuideOnDeviceModel:BypassPerfRequirement/true,AIPromptAPI',
    `http://localhost:${PORT}/bridge`,
  ], { stdio: 'ignore' });
  const stop = () => { chrome.kill('SIGTERM'); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
});
