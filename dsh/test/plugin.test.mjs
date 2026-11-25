import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as plugin from '../index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('apply registers the agy skill with the absolute dispatcher command', () => {
  const calls = []
  plugin.apply({ skills: { register: (s) => calls.push(s) }, logger: { warn() {} } })
  assert.equal(calls.length, 1)
  const s = calls[0]
  assert.equal(s.name, 'agy')
  assert.equal(s.source, 'plugin')
  assert.ok(s.description.length > 20)
  assert.match(s.whenToUse, /agy/)
  assert.ok(!s.content.includes('{{AGY}}'), 'placeholder must be filled')
  assert.ok(s.content.includes(plugin.agyCommand()), 'content uses the dispatcher command')
  assert.ok(fs.existsSync(plugin.SCRIPT))
  assert.deepEqual(plugin.inject, ['skills'])
})

test('agyCommand quotes paths with spaces and quotes', () => {
  assert.equal(plugin.agyCommand('/a/b/agy.mjs'), 'node /a/b/agy.mjs')
  assert.equal(plugin.agyCommand("/a b/it's/agy.mjs"), "node '/a b/it'\\''s/agy.mjs'")
})

test('install-skill writes and removes a filesystem skill', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyd-dsh-'))
  const inst = path.join(here, '..', 'install-skill.mjs')
  const r = spawnSync(process.execPath, [inst, '--dir', dir], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const body = fs.readFileSync(path.join(dir, 'agy', 'SKILL.md'), 'utf8')
  assert.match(body, /^---\nname: agy\n/)
  assert.ok(body.includes(plugin.agyCommand()))
  assert.equal(spawnSync(process.execPath, [inst, '--dir', dir, '--uninstall']).status, 0)
  assert.ok(!fs.existsSync(path.join(dir, 'agy')))
})
