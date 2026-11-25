#!/usr/bin/env node
// Entry point for the Codex skill; the dispatcher itself lives at <plugin root>/scripts/agy.mjs.
await import(new URL('../../../../scripts/agy.mjs', import.meta.url).href);
