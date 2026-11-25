#!/usr/bin/env node
// Install the agy skill as a plain filesystem skill for every dsh profile:
//   node dsh/install-skill.mjs                 -> $DSH_HOME/skills/agy/SKILL.md (default ~/.dsh)
//   node dsh/install-skill.mjs --dir <skills>  -> <skills>/agy/SKILL.md
//   node dsh/install-skill.mjs --uninstall
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { render, TEMPLATE, SCRIPT } from './index.mjs'

const args = process.argv.slice(2)
const dirIdx = args.indexOf('--dir')
const skillsDir = dirIdx >= 0 ? path.resolve(args[dirIdx + 1]) : path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'skills')
const target = path.join(skillsDir, 'agy', 'SKILL.md')

if (args.includes('--uninstall')) {
  fs.rmSync(path.dirname(target), { recursive: true, force: true })
  console.log('removed ' + path.dirname(target))
} else {
  if (!fs.existsSync(SCRIPT)) { console.error('dispatcher missing: ' + SCRIPT); process.exit(1) }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, render(fs.readFileSync(TEMPLATE, 'utf8')))
  console.log('installed ' + target + ' (dispatcher ' + SCRIPT + ')')
}
