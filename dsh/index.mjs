/**
 * agy-dispatch for DeepSeek Harness (dsh): a Cordis plugin that registers the `agy` skill.
 * The skill text lives in SKILL.md next to this file; {{AGY}} is replaced with the absolute
 * command for this checkout's dispatcher (../scripts/agy.mjs), so the model never has to guess paths.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'agy-dispatch'
export const inject = ['skills']

export const SCRIPT = fileURLToPath(new URL('../scripts/agy.mjs', import.meta.url))
export const TEMPLATE = fileURLToPath(new URL('./SKILL.md', import.meta.url))

/** Shell-safe command for the dispatcher. */
export function agyCommand(script = SCRIPT) {
  return 'node ' + (/^[\w./@:+-]+$/.test(script) ? script : "'" + script.replace(/'/g, "'\\''") + "'")
}

/** Fill {{AGY}} in the template. */
export function render(template, script = SCRIPT) {
  return template.replaceAll('{{AGY}}', agyCommand(script))
}

/** Split single-line YAML frontmatter (name, description, whenToUse) from the body. */
export function parseSkill(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) throw new Error('agy-dispatch: SKILL.md has no frontmatter')
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]] = kv[2].trim()
  }
  if (!meta.name || !meta.description) throw new Error('agy-dispatch: SKILL.md needs name and description')
  return { name: meta.name, description: meta.description, whenToUse: meta.whenToUse, content: raw.slice(m[0].length).trim() }
}

export function apply(ctx) {
  if (!existsSync(SCRIPT)) {
    ctx.logger?.warn?.(`agy-dispatch: dispatcher not found at ${SCRIPT}; install the whole agy-dispatch checkout, not only dsh/`)
    return
  }
  const skill = parseSkill(render(readFileSync(TEMPLATE, 'utf8')))
  ctx.skills.register({
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
    content: skill.content,
    source: 'plugin',
    path: TEMPLATE,
  })
}
