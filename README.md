# nano-openai

Runs Chrome's on-device **Gemini Nano** model (`weights.bin`) behind an
**OpenAI-compatible HTTP API**, from the command line.

## Why it works this way

The 4 GB `weights.bin` in
`~/Library/Application Support/Google/Chrome/OptGuideOnDeviceModel/` is **not**
a self-describing model file. It has no container header, no graph, no tensor
names, no tokenizer — it is a raw packed quantized tensor blob. The
architecture, decode loop and tokenizer are compiled into Chrome's runtime
(`OnDeviceModelLitertLmBackend`). So it **cannot** be converted to GGUF or
loaded by llama.cpp / Ollama / MediaPipe.

The only thing that can run this file is Chrome itself. So `nano-openai`:

1. Clones the model into a dedicated Chrome profile (APFS copy-on-write —
   instant, ~0 extra disk, never touches your real Chrome).
2. Launches a headless Chrome that hosts the model via the built-in
   **Prompt API** (`LanguageModel`).
3. Bridges that to a local OpenAI-shaped endpoint.

The model that answers is bit-for-bit the `weights.bin` Chrome installed.

## Setup

There is **nothing to `npm install`** — `server.js` uses only Node built-ins
and the global `fetch`/`WebSocket` (hence Node >= 22). You need:

- **macOS** on an APFS volume (for the instant copy-on-write model clone).
- **Google Chrome** installed at the standard location, or set `NANO_CHROME`.
- The **Gemini Nano on-device model** available to Chrome (see below).

### Getting the model (`weights.bin`)

`nano-openai` never downloads or ships the model. It uses the ~4 GB
`weights.bin` that Chrome installs at:

```
~/Library/Application Support/Google/Chrome/OptGuideOnDeviceModel/
```

You get it one of two ways:

1. **You already have it.** If you've used Chrome's built-in AI features, the
   folder above already exists. On first run `nano-openai` clones it into a
   dedicated profile via APFS copy-on-write — instant, ~0 extra disk, and your
   real Chrome profile is never touched.
2. **You don't have it yet.** If that folder is missing, `nano-openai` logs a
   warning and continues. The dedicated headless Chrome it launches will then
   try to **download** the model itself (Chrome verifies hardware and fetches
   the component). This takes longer and needs ~free disk + a capable machine.

Either way, the model ends up only inside this project's `chrome-profile/`
directory (git-ignored), separate from your everyday Chrome.

## Run

```sh
node server.js
# or: npm start
```

The first start takes ~15–20 s while Chrome verifies/installs the model
component (longer if it has to download it). Watch the log — when you see
`READY`, the endpoint is live. `GET /healthz` reports the current
`availability` if it's still starting up.

```sh
# list models
curl localhost:8765/v1/models

# chat
curl localhost:8765/v1/chat/completions -H 'content-type: application/json' -d '{
  "model": "gemini-nano",
  "messages": [{"role": "user", "content": "Write a haiku about local AI."}]
}'

# streaming
curl -N localhost:8765/v1/chat/completions -H 'content-type: application/json' -d '{
  "model": "gemini-nano", "stream": true,
  "messages": [{"role": "user", "content": "Count to five."}]
}'
```

Point any OpenAI client at it:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8765/v1", api_key="not-needed")
print(client.chat.completions.create(
    model="gemini-nano",
    messages=[{"role": "user", "content": "hello"}],
).choices[0].message.content)
```

## Endpoints

- `GET  /v1/models`
- `POST /v1/chat/completions`  — supports `stream`, `temperature`, `top_k`,
  system messages, multi-turn history
- `GET  /healthz` — bridge/model status

## Config (env vars)

| Var | Default | Meaning |
|---|---|---|
| `NANO_PORT` | `8765` | HTTP API port |
| `NANO_CDP_PORT` | `9765` | Chrome DevTools port (internal) |
| `NANO_HEADLESS` | `1` | set `0` to see the Chrome window |
| `NANO_CHROME_UDD` | `./chrome-profile` | dedicated Chrome profile dir |
| `NANO_CHROME` | system Chrome | path to Chrome binary |

## Stop

`Ctrl-C` (kills the background Chrome too).

## Notes / limits

- Gemini Nano is small; expect short, simple completions. No tool use here.
- `max_tokens` is ignored (the Prompt API has no hard output cap).
- Don't redistribute `weights.bin` — unclear license. This is local use only.

## License

MIT — see [LICENSE](LICENSE). Covers this bridge code only, not the model.
