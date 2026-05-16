#!/usr/bin/env node
/*
 * nano-openai chat — a command-line chat client for the local server.
 *
 *   1. start the server:  node server.ts   (wait for "READY")
 *   2. run this:          node chat.ts
 *
 * It talks to the server through the official `openai` SDK, exactly the way
 * any OpenAI app would — proof the endpoint is genuinely OpenAI-compatible.
 * Needs the `openai` package, so run `npm install` once first.
 *
 * Type a message and press enter. "exit" (or Ctrl-C / Ctrl-D) quits.
 */
import OpenAI from 'openai';
import { createInterface } from 'node:readline';

const client = new OpenAI({
  baseURL: process.env.NANO_URL ?? 'http://localhost:8765/v1',
  apiKey: 'not-needed',                       // the server ignores auth
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on('SIGINT', () => { console.log('\nbye.'); process.exit(0); });

// The whole conversation, replayed on every request so the model has context.
const history: { role: 'user' | 'assistant'; content: string }[] = [];

console.log('nano-openai chat — type a message, "exit" to quit.\n');
process.stdout.write('you  ');

// `for await` queues lines that arrive while a reply is still generating,
// so nothing typed ahead (or piped in) is lost.
for await (const line of rl) {
  const input = line.trim();
  if (input === 'exit' || input === 'quit') break;
  if (input) {
    history.push({ role: 'user', content: input });
    try {
      const res = await client.chat.completions.create({
        model: 'gemini-nano',
        messages: history,
      });
      const reply = res.choices[0]?.message.content?.trim() || '(empty reply)';
      history.push({ role: 'assistant', content: reply });
      console.log('nano ' + reply + '\n');
    } catch (err) {
      history.pop();                          // forget the failed turn
      if (err instanceof OpenAI.APIConnectionError)
        console.log('!! cannot reach the server — is `node server.ts` running?\n');
      else if (err instanceof OpenAI.APIError && err.status === 503)
        console.log('!! server is up but the model is not READY yet — check its log.\n');
      else
        console.log('!! ' + (err instanceof Error ? err.message : String(err)) + '\n');
    }
  }
  process.stdout.write('you  ');
}

rl.close();
console.log('\nbye.');
