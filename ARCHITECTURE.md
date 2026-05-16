# Architecture

How `nano-openai` runs Chrome's on-device Gemini Nano behind an
OpenAI-compatible API, and why it's built this way.

## The constraint that shapes everything

Chrome installs its on-device model at:

```
~/Library/Application Support/Google/Chrome/OptGuideOnDeviceModel/<version>/
├── weights.bin          ~4.27 GB — a raw, headerless tensor blob
├── on_device_model_execution_config.pb   prompt/control-token config
├── manifest.json        { BaseModelSpec: { name: "v3Nano", ... } }
├── encoder_cache.bin    (runtime cache, empty until used)
└── adapter_cache.bin    (runtime cache, empty until used)
```

`weights.bin` is **not** a self-describing model file:

- No magic bytes — `file` reports `data`. It is not a TFLite/LiteRT
  flatbuffer (no `TFL3` header) and not a `.task` zip bundle (no `PK` header).
- No embedded graph, no tensor names, no tokenizer. The tokenizer and the
  control-token scheme (e.g. `<ctrl23>`) live in the sidecar `.pb`.
- The model architecture, decode loop, and sampling are **compiled into
  Chrome's runtime** (the LiteRT-LM / `OnDeviceModelLitertLmBackend` backend).

**Consequence:** the file cannot be loaded by llama.cpp, Ollama, or stock
MediaPipe `LlmInference`. The only thing that can interpret it is the Chrome
runtime that produced it. So instead of porting the model to another runtime,
`nano-openai` borrows Chrome's runtime as a subprocess.

The model is reached only through a **web API** — `LanguageModel`, the Prompt
API — which exists only inside a page's JavaScript context. That is why the
design needs a *page*, not just a headless process.

## The pieces

| Piece | Runtime | Role |
|---|---|---|
| `server.ts` | Node ≥22.18 | HTTP server: OpenAI API + bridge endpoints; spawns Chrome |
| headless Chrome | Chrome process | Hosts the model via LiteRT-LM; owns `weights.bin` |
| bridge page | page JS in Chrome | Calls the Prompt API; relays jobs to/from the server |

The bridge page is **not a separate file** — it is the `BRIDGE_HTML` string
embedded at the bottom of `server.ts`, served at `GET /bridge`, so the whole
project is a single source file.

The server logic never touches the model; the bridge page never speaks OpenAI.
The HTTP server in the middle is the only thing both sides share.

## Data flow

```
   OpenAI client                server.ts (Node :8765)              headless Chrome
   (curl, SDK)                                                      └ bridge page
        │                                                                 │
        │  POST /v1/chat/completions                                      │
        ├────────────────────────────►  chat()                            │
        │                               • normalize messages              │
        │                               • make job id                     │
        │                               • register jobs.set(id, cb)        │
        │                               • push job on the control SSE ────►│  run()
        │                                                                  │  • LanguageModel.create()
        │                                                                  │  • session.prompt()
        │                               POST /bridge/done {result}  ◄──────┤  on completion
        │   JSON response            ◄──  job(result)                      │
        │◄───────────────────────────                                      │
```

One long-lived SSE stream out, plain POSTs back:

1. **Control channel — `GET /bridge/events`** (server → Chrome, SSE).
   Opened once by the bridge page at startup. The server holds the single
   response object in the `bridge` variable and writes job descriptors to it.
   A `: ping` comment every 15 s keeps it alive.

2. **Result callback — `POST /bridge/done`** (Chrome → server, plain POST).
   SSE is one-directional, so the page sends the finished result *back* as an
   ordinary POST rather than over a second stream.

3. **Client response** (server → OpenAI client). A single buffered
   `chat.completion` JSON. Responses are not streamed — see *Known limits*.

### Job correlation

Every request gets an `id` of the form `chatcmpl-<timestamp>`. The server
keeps an in-memory `jobs: Map<id, (result, err) => void>` — one callback per
in-flight request.

When the `/bridge/done` POST arrives, the server looks up `jobs.get(id)` and
invokes that callback, which sends the `chat.completion` JSON (or a `500` if
the page reported an error) and deletes the entry.

A 180 s `setTimeout` per job invokes the same callback with a timeout error as
a safety net; the real result POST arriving later is a harmless no-op (the id
is already gone from the map).

## Lifecycle

### Startup

1. `server.listen(PORT)` — HTTP server up.
2. `spawn(CHROME, …)` — headless Chrome launches, opening
   `http://localhost:PORT/bridge`.
3. Chrome loads the bridge page (`GET /bridge`) → `init()` runs:
   - Checks `LanguageModel` exists and calls `availability()`.
   - If the model isn't `available` yet, calls `LanguageModel.create()` with a
     `downloadprogress` monitor to nudge Chrome into fetching/loading it.
   - `POST /bridge/hello` with the final availability.
4. Server sets `ready = true` on `availability === 'available'` and logs
   `READY`.
5. The bridge page opens the control SSE (`/bridge/events`). Requests can now
   be served; until then `/v1/chat/completions` returns `503`.

### Per request

`chat()` → register job → push to control SSE → `run()` in the page creates a
fresh `LanguageModel` session (history becomes `initialPrompts`, the last
message becomes the prompt) → `session.prompt()` returns the full text →
`POST /bridge/done` → the job callback fires → session destroyed.

### Shutdown

`SIGINT`/`SIGTERM` → `chrome.kill('SIGTERM')` → `process.exit`. The dedicated
profile is left intact for the next run.

## Chrome launch flags — why each one

```
--headless=new
--user-data-dir=./chrome-profile        dedicated profile; never touches real Chrome
--no-first-run --no-default-browser-check   skip onboarding UI
--disable-renderer-backgrounding            keep the page's JS at full speed…
--disable-background-timer-throttling       …since a headless tab is never "focused"
--enable-features=OptimizationGuideOnDeviceModel:BypassPerfRequirement/true,AIPromptAPI
                                            enable the on-device model even below the
                                            perf bar, and enable the Prompt API
```

The dedicated `chrome-profile/` is where `weights.bin` must live. It is
deliberately separate from your everyday Chrome profile so the two never
contend for the same profile lock, and so the project never reads or mutates
your real browser state.

## Design decisions and trade-offs

- **Chrome as the runtime — not a choice, a constraint.** Nothing else can
  execute `weights.bin`. The cost is carrying a full browser subprocess.
- **A page, not pure CDP.** The Prompt API is page-scoped JS, so a hosted
  page is required — kept inline as `BRIDGE_HTML` and served at `/bridge`.
  Earlier versions used the DevTools Protocol to inject a synthetic
  user-gesture for first-run downloads; that was dropped for simplicity — the
  page now nudges the download itself.
- **POST-back instead of a WebSocket.** One SSE stream out + a plain POST back
  is enough, needs zero dependencies, and keeps the code tiny.
- **No streaming.** The bridge calls `session.prompt()` (not
  `promptStreaming()`) and returns the whole completion in one POST. This drops
  the per-token relay, the `/bridge/chunk` endpoint, and the cumulative-vs-delta
  workaround Chrome's streaming API needs. Gemini Nano is small and fast enough
  that buffering is barely noticeable for a local tool.
- **Single bridge connection.** Exactly one Chrome page is expected; the
  `bridge` variable holds one SSE response, last-writer-wins. Simple, and
  sufficient for a local single-user tool.
- **No weights redistribution.** The project ships no model. It uses the copy
  Chrome already installed on the machine, sidestepping the unclear license on
  `weights.bin`.
- **Native TypeScript, zero deps.** `server.ts` runs directly under Node's
  type stripping — no build step, no `node_modules`.

## Known limits

- **Concurrency is naive.** Jobs are dispatched as they arrive; the page may
  run several `LanguageModel` sessions at once. Fine for local use, not built
  for load.
- **No streaming.** `"stream": true` in a request is ignored; the client
  always gets one buffered JSON response.
- **Sampling params ignored.** `temperature`, `top_k`, and `max_tokens` from
  the request are not applied — the model runs with its defaults.
- **macOS-oriented.** The default Chrome path and profile assumptions target
  macOS; other platforms need `NANO_CHROME` set.
- **Coupled to an experimental API.** The Prompt API and the on-device model
  packaging are unstable; a Chrome update can change behavior or break the
  bridge.
- **The model must already be in the profile.** First run will let headless
  Chrome download it (~4 GB, slow); see the README for the faster manual copy.
