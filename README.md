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

## Run

```sh
node server.js
```

First start takes ~15–20 s (Chrome verifies/installs the model component).
When you see `READY`, the endpoint is live.

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

## Requirements

- macOS with Google Chrome installed (the on-device model must already be
  present in your Chrome profile).
- Node.js >= 22 (uses the built-in `fetch` and `WebSocket` globals; no
  dependencies to install).

## License

MIT — see [LICENSE](LICENSE). Covers this bridge code only, not the model.
