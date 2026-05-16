#!/usr/bin/env node
'use strict';
// Gemini Nano -> OpenAI-compatible local server.
// The 4GB Chrome on-device model (weights.bin) can only be run by Chrome's
// runtime, so this spawns a headless Chrome that hosts the model via the
// Prompt API and bridges it to an OpenAI-shaped HTTP endpoint.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PORT = parseInt(process.env.NANO_PORT || '8765', 10);
const CDP_PORT = parseInt(process.env.NANO_CDP_PORT || '9765', 10);
const HEADLESS = process.env.NANO_HEADLESS !== '0';
const HOME = os.homedir();
const WORK = __dirname;
const UDD = process.env.NANO_CHROME_UDD || path.join(WORK, 'chrome-profile');
const CHROME = process.env.NANO_CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REAL_MODEL = path.join(HOME,
  'Library/Application Support/Google/Chrome/OptGuideOnDeviceModel');
const MODEL_ID = 'gemini-nano';

let bridgeRes = null;                       // SSE conn to the in-Chrome page
let bridgeInfo = { ready: false, availability: 'starting' };
const jobs = new Map();                     // jobId -> { chunk, done }
let jobSeq = 0;

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(ts(), ...a);

// ---- helpers ---------------------------------------------------------------
function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
function sendJson(res, code, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}
function flatten(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  return c == null ? '' : String(c);
}
function pushJob(obj) {
  if (!bridgeRes) return false;
  bridgeRes.write(`data: ${JSON.stringify(obj)}\n\n`);
  return true;
}

// ---- chat completion -------------------------------------------------------
async function handleChat(req, res) {
  const body = await readJson(req);
  if (!bridgeRes || !bridgeInfo.ready) {
    return sendJson(res, 503, { error: {
      message: `Gemini Nano not ready (status: ${bridgeInfo.availability}). See server log / chrome.log.`,
      type: 'server_error' } });
  }
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .map((m) => ({ role: m.role, content: flatten(m.content) }));
  if (!messages.length) {
    return sendJson(res, 400, { error: { message: 'messages[] required', type: 'invalid_request_error' } });
  }
  const stream = !!body.stream;
  const id = 'chatcmpl-' + Date.now() + '-' + (++jobSeq);
  const created = Math.floor(Date.now() / 1000);
  const opts = {
    messages,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topK: typeof body.top_k === 'number' ? body.top_k : undefined,
  };

  let timer = setTimeout(() => {
    const j = jobs.get(id);
    if (j) j.done('timed out after 180s');
  }, 180000);

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created,
      model: MODEL_ID, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
    jobs.set(id, {
      chunk: (delta) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk',
        created, model: MODEL_ID,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`),
      done: (err) => {
        clearTimeout(timer);
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created,
          model: MODEL_ID,
          choices: [{ index: 0, delta: {}, finish_reason: err ? 'error' : 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        jobs.delete(id);
      },
    });
  } else {
    let acc = '';
    jobs.set(id, {
      chunk: (delta) => { acc += delta; },
      done: (err) => {
        clearTimeout(timer);
        if (err) return sendJson(res, 500, { error: { message: String(err), type: 'server_error' } });
        const promptTok = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
        const compTok = Math.ceil(acc.length / 4);
        sendJson(res, 200, {
          id, object: 'chat.completion', created, model: MODEL_ID,
          choices: [{ index: 0, message: { role: 'assistant', content: acc }, finish_reason: 'stop' }],
          usage: { prompt_tokens: promptTok, completion_tokens: compTok, total_tokens: promptTok + compTok },
        });
        jobs.delete(id);
      },
    });
  }
  pushJob({ type: 'job', id, opts });
}

// ---- http server -----------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    });
    return res.end();
  }

  // --- bridge page + channel ---
  if (p === '/bridge' && req.method === 'GET') {
    const html = fs.readFileSync(path.join(WORK, 'bridge.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  if (p === '/bridge/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    bridgeRes = res;
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    req.on('close', () => { clearInterval(ping); if (bridgeRes === res) bridgeRes = null; });
    return;
  }
  if (p === '/bridge/hello' && req.method === 'POST') {
    const b = await readJson(req);
    bridgeInfo = { ready: b.availability === 'available', availability: b.availability, params: b.params };
    log(`bridge hello -> availability=${b.availability}`, b.params || '');
    if (bridgeInfo.ready) log('READY. Endpoint: http://localhost:' + PORT + '/v1/chat/completions');
    else if (b.availability === 'downloadable' || b.availability === 'downloading') triggerInstall();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/bridge/chunk' && req.method === 'POST') {
    const b = await readJson(req);
    const j = jobs.get(b.id);
    if (j) j.chunk(b.delta || '');
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/bridge/done' && req.method === 'POST') {
    const b = await readJson(req);
    const j = jobs.get(b.id);
    if (j) j.done(b.error);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/bridge/log' && req.method === 'POST') {
    const b = await readJson(req);
    log('[chrome]', b.line || '');
    return sendJson(res, 200, { ok: true });
  }

  // --- OpenAI-compatible API ---
  if (p === '/v1/models' && req.method === 'GET') {
    return sendJson(res, 200, { object: 'list', data: [
      { id: MODEL_ID, object: 'model', created: 0, owned_by: 'google-chrome-on-device' },
    ] });
  }
  if (p === '/v1/chat/completions' && req.method === 'POST') {
    return handleChat(req, res);
  }
  if ((p === '/healthz' || p === '/') && req.method === 'GET') {
    return sendJson(res, 200, {
      service: 'nano-openai',
      model: MODEL_ID,
      bridge_connected: !!bridgeRes,
      ready: bridgeInfo.ready,
      availability: bridgeInfo.availability,
      endpoint: `http://localhost:${PORT}/v1/chat/completions`,
    });
  }
  sendJson(res, 404, { error: { message: 'not found: ' + p, type: 'invalid_request_error' } });
});

// ---- setup + chrome launch -------------------------------------------------
function ensureModel() {
  const dest = path.join(UDD, 'OptGuideOnDeviceModel');
  if (fs.existsSync(dest)) { log('model profile already present:', dest); return; }
  if (!fs.existsSync(REAL_MODEL)) {
    log('WARNING: Chrome on-device model not found at', REAL_MODEL);
    return;
  }
  fs.mkdirSync(UDD, { recursive: true });
  log('cloning on-device model into dedicated profile (APFS copy-on-write, instant)...');
  try {
    execFileSync('cp', ['-Rc', REAL_MODEL, UDD + path.sep]); // -c = CoW clone on APFS
  } catch {
    log('CoW clone unavailable, doing a full copy (~4GB)...');
    execFileSync('cp', ['-R', REAL_MODEL, UDD + path.sep]);
  }
  log('model ready in profile.');
}

// ---- DevTools Protocol: trigger the activation-gated model install --------
async function findPageWs(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`http://localhost:${CDP_PORT}/json/list`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === 'page' && /\/bridge/.test(t.url || ''));
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* chrome not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('CDP page target not found');
}

function cdpEval(wsUrl, expression, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP eval timeout')); }, timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression, awaitPromise: true, userGesture: true, returnByValue: true } }));
    });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      const r = msg.result && msg.result.result;
      if (r && r.subtype === 'error') return reject(new Error(r.description || 'eval error'));
      resolve(r ? r.value : undefined);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP ws error')); });
  });
}

let installAttempts = 0;
let installing = false;
async function triggerInstall() {
  if (installing || bridgeInfo.ready) return;
  if (installAttempts >= 3) { log('install: giving up after 3 attempts.'); return; }
  installing = true;
  installAttempts++;
  try {
    log(`install attempt ${installAttempts}: creating session with synthetic user-gesture via CDP...`);
    const wsUrl = await findPageWs();
    const expr = `(async()=>{try{`
      + `const s=await LanguageModel.create({monitor(m){m.addEventListener('downloadprogress',e=>{});}});`
      + `s.destroy();return 'ok:'+(await LanguageModel.availability());`
      + `}catch(e){return 'err:'+((e&&e.message)||e);}})()`;
    const result = await cdpEval(wsUrl, expr);
    log('install result:', result);
    const ws2 = await findPageWs();
    await cdpEval(ws2, 'location.reload()', 10000).catch(() => {});
  } catch (e) {
    log('install error:', e.message || e);
  } finally {
    installing = false;
  }
}

let chrome = null;
function launchChrome() {
  const args = [
    `--user-data-dir=${UDD}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-features=OptimizationGuideOnDeviceModel:BypassPerfRequirement/true,AIPromptAPI',
    `http://localhost:${PORT}/bridge`,
  ];
  if (HEADLESS) args.unshift('--headless=new');
  else args.push('--window-size=520,400');
  const logPath = path.join(WORK, 'chrome.log');
  const fd = fs.openSync(logPath, 'w');
  chrome = spawn(CHROME, args, { stdio: ['ignore', fd, fd] });
  log(`launched Chrome (${HEADLESS ? 'headless' : 'windowed'}), logs -> ${logPath}`);
  chrome.on('exit', (code) => log('Chrome exited, code', code));
}

function shutdown() {
  log('shutting down...');
  try { if (chrome) chrome.kill('SIGTERM'); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  log(`nano-openai listening on http://localhost:${PORT}`);
  ensureModel();
  launchChrome();
  log('waiting for Gemini Nano to come up inside Chrome...');
});
