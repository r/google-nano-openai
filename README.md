# nano-openai

Runs Chrome's on-device **Gemini Nano** model behind an **OpenAI-compatible
HTTP API**, from the command line. Single TypeScript file, zero dependencies.

## Why it works this way

The 4 GB `weights.bin` Chrome installs in
`~/Library/Application Support/Google/Chrome/OptGuideOnDeviceModel/` is **not**
a self-describing model file — no container, no graph, no tokenizer. The
architecture, decode loop and tokenizer are compiled into Chrome's runtime, so
it **cannot** be converted to GGUF or loaded by llama.cpp / Ollama.

The only thing that can run it is Chrome. So `nano-openai`:

1. Launches a headless Chrome on a dedicated profile (`./chrome-profile/`).
2. That Chrome hosts the model via the built-in **Prompt API** (`LanguageModel`).
3. A tiny bridge page (embedded in `server.ts`) relays jobs to/from a local
   OpenAI-shaped endpoint.

For the full design — data flow, the bridge protocol, and the trade-offs —
see [ARCHITECTURE.md](ARCHITECTURE.md).

## Requirements

- **macOS** with **Google Chrome** (standard install path, or set `NANO_CHROME`).
- **Node ≥ 22.18** — runs `server.ts` directly via Node's native type stripping.
  Nothing to `npm install`.
- The **Gemini Nano model** in this project's `chrome-profile/` directory. On
  first run, headless Chrome downloads it there (~4 GB, one-time, slow). To skip
  the download, copy your existing model in first:

  ```sh
  cp -Rc ~/Library/Application\ Support/Google/Chrome/OptGuideOnDeviceModel \
        chrome-profile/
  ```

  (`-c` is an instant APFS copy-on-write clone — ~0 extra disk.)

## Run

```sh
node server.ts        # or: npm start
```

Watch the log — when you see `READY`, the endpoint is live.

```sh
curl localhost:8765/v1/chat/completions -H 'content-type: application/json' -d '{
  "model": "gemini-nano",
  "messages": [{"role": "user", "content": "Write a haiku about local AI."}]
}'
```

Any OpenAI client works too:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8765/v1", api_key="not-needed")
print(client.chat.completions.create(
    model="gemini-nano",
    messages=[{"role": "user", "content": "hello"}],
).choices[0].message.content)
```

## Chat from the command line

`chat.ts` is a tiny interactive client — it connects to the running server
through the official `openai` SDK and lets you hold a conversation:

```sh
npm install        # one-time: the `openai` SDK (dev-only; the server needs nothing)
node chat.ts       # or: npm run chat
```

```
nano-openai chat — type a message, "exit" to quit.

you  what is a haiku?
nano A haiku is a three-line poem with 5, 7, and 5 syllables.

you  exit
bye.
```

It replays the full conversation on each request, so context carries across
turns. `exit`, Ctrl-C, or Ctrl-D quits.

## Endpoints

- `GET  /v1/models`
- `POST /v1/chat/completions` — system messages and multi-turn history; replies
  are buffered, not streamed
- `GET  /healthz` — bridge/model status

## Config (env vars)

| Var | Default | Meaning |
|---|---|---|
| `NANO_PORT` | `8765` | HTTP API port |
| `NANO_CHROME_UDD` | `./chrome-profile` | dedicated Chrome profile dir |
| `NANO_CHROME` | system Chrome | path to Chrome binary |

## Notes / limits

- Gemini Nano is small; expect short, simple completions. No tool use.
- No streaming — `"stream": true` is ignored; the full reply comes at once.
- `temperature`, `top_k` and `max_tokens` are ignored — model defaults only.
- Don't redistribute `weights.bin` — unclear license. Local use only.
- `Ctrl-C` stops the server and its background Chrome.

## License

MIT — see [LICENSE](LICENSE). Covers this bridge code only, not the model.
