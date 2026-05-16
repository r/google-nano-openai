#!/usr/bin/env node
/*
 * nano-openai — Chrome's on-device Gemini Nano behind an OpenAI-compatible API.
 *
 * WHY THIS SHAPE
 *   Chrome's on-device model (`weights.bin`, ~4 GB) is a raw, headerless tensor
 *   blob — no graph, no tokenizer. Its architecture and decode loop are compiled
 *   into Chrome's LiteRT-LM runtime, so it can't be loaded by llama.cpp / Ollama
 *   / MediaPipe. The only thing that can run it is Chrome, and only via the
 *   page-scoped Prompt API (`LanguageModel`). So this server borrows Chrome:
 *     1. spawns a headless Chrome pointed at its own `/bridge` page,
 *     2. that page (the BRIDGE_HTML at the bottom of this file) hosts the model
 *        via the Prompt API,
 *     3. requests are relayed page <-> server over plain HTTP.
 *
 * DATA FLOW
 *   OpenAI client  --POST /v1/chat/completions-->  server
 *   server         --job over SSE /bridge/events->  Chrome page
 *   Chrome page    --POST /bridge/done (result)-->  server
 *   server         --JSON response--------------->  OpenAI client
 *   Jobs are correlated by an `id`; see the `jobs` map and chat() below.
 *   Responses are not streamed — `"stream": true` in a request is ignored.
 *
 * REQUIRES
 *   - Node >=22.18: runs this .ts directly via native type stripping, zero deps.
 *   - macOS + Google Chrome, with the Gemini Nano model already installed.
 *
 * This is a single self-contained file — the in-Chrome page is the BRIDGE_HTML
 * string at the bottom.   RUN:  node server.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const PORT = Number(process.env.NANO_PORT ?? 8765);
const CHROME = process.env.NANO_CHROME ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UDD = process.env.NANO_CHROME_UDD ?? join(import.meta.dirname, 'chrome-profile');
const MODEL = 'gemini-nano';

type Msg = { role: string; content: string };
type Job = (result: string, err?: string) => void;   // called once when the job finishes

let bridge: ServerResponse | null = null;   // the one open SSE conn to the Chrome page
let ready = false;                          // true once the bridge page reports model ready
const jobs = new Map<string, Job>();        // in-flight requests, keyed by job id

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

// POST /v1/chat/completions — register a job, hand it to the bridge page, and
// reply with the full completion once the page POSTs the result back.
// Responses are not streamed; a `"stream": true` in the request is ignored.
async function chat(req: IncomingMessage, res: ServerResponse) {
  const b = await body(req);
  log(`chat: ${(b.messages ?? []).length} message(s)`);
  if (!bridge || !ready) return json(res, 503, { error: { message: 'Gemini Nano not ready' } });

  const messages: Msg[] = (b.messages ?? []).map((m: any) => ({
    role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
    content: text(m.content),
  }));
  if (!messages.length) return json(res, 400, { error: { message: 'messages[] required' } });

  const id = 'chatcmpl-' + Date.now();
  const created = Math.floor(Date.now() / 1000);
  const timer = setTimeout(() => jobs.get(id)?.('', 'timed out after 180s'), 180_000);

  // Fired once when the bridge page reports the result (or an error).
  jobs.set(id, (result, err) => {
    clearTimeout(timer);
    jobs.delete(id);
    if (err) return json(res, 500, { error: { message: err } });
    json(res, 200, { id, object: 'chat.completion', created, model: MODEL,
      choices: [{ index: 0,
        message: { role: 'assistant', content: result }, finish_reason: 'stop' }] });
  });

  // Dispatch the job to the bridge page over the control SSE; it runs the
  // model and POSTs the result back to /bridge/done.
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

  // --- in-Chrome bridge page + channel (talks to the bridge page, not the user) ---
  if (pathname === '/bridge' && get) {            // the page headless Chrome loads
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(BRIDGE_HTML);
  }
  if (pathname === '/bridge/events' && get) {     // control channel: server -> page (SSE)
    res.writeHead(200, { 'content-type': 'text/event-stream',
      'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    bridge = res;
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => { clearInterval(ping); if (bridge === res) bridge = null; });
    return;
  }
  if (pathname === '/bridge/hello' && post) {     // page reports model availability
    const b = await body(req);
    ready = b.availability === 'available';
    log('bridge:', b.availability, ready ? '— READY' : '');
    return json(res, 200, { ok: true });
  }
  if (pathname === '/bridge/done' && post) {      // page returns the finished result
    const b = await body(req);
    jobs.get(b.id)?.(b.result ?? '', b.error);
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

// --- the page headless Chrome loads -----------------------------------------
// Embedded so this stays a single file. It hosts the model via the Prompt API,
// opens the control SSE, runs each job, and POSTs the result to /bridge/done.
const BRIDGE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Gemini Nano bridge</title>
<body style="font-family:system-ui;margin:1.5em;color:#222">
<h3>Gemini Nano &harr; OpenAI bridge</h3>
<p>This headless Chrome page hosts the on-device model. Keep it running.</p>
<pre id="log" style="background:#f4f4f4;padding:1em;white-space:pre-wrap"></pre>
<script>
const logEl = document.getElementById('log');
function log(...a) {
  const line = a.join(' ');
  logEl.textContent += line + '\\n';
  fetch('/bridge/log', { method: 'POST', body: JSON.stringify({ line }) }).catch(() => {});
}
const post = (path, body) =>
  fetch(path, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});

async function init() {
  if (!('LanguageModel' in self)) {
    log('ERROR: Prompt API (LanguageModel) not available — flags not applied.');
    return post('/bridge/hello', { availability: 'no-api' });
  }
  let avail = await LanguageModel.availability();
  log('availability:', avail);
  // Anything other than available/unavailable means the model needs a load/download.
  if (avail !== 'available' && avail !== 'unavailable') {
    log('triggering model load...');
    try {
      const s = await LanguageModel.create({
        monitor: (m) => m.addEventListener('downloadprogress',
          (e) => log('download', Math.round((e.loaded || 0) * 100) + '%')),
      });
      s.destroy();
      avail = await LanguageModel.availability();
      log('availability now:', avail);
    } catch (e) { log('load failed:', e.message || e); }
  }
  await post('/bridge/hello', { availability: avail });
  if (avail === 'available') {
    log('connected — server is READY.');
    new EventSource('/bridge/events').onmessage =
      (ev) => { try { run(JSON.parse(ev.data)); } catch {} };
  }
}

async function run({ id, messages }) {
  let session;
  try {
    const history = messages.slice(0, -1);
    const last = messages[messages.length - 1]?.content ?? '';
    session = await LanguageModel.create(history.length ? { initialPrompts: history } : {});
    const result = await session.prompt(last);
    await post('/bridge/done', { id, result });
  } catch (e) {
    await post('/bridge/done', { id, error: String(e.message || e) });
  } finally {
    session?.destroy();
  }
}

init();
</script>`;
