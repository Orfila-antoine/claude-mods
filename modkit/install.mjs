import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = join(dirname(fileURLToPath(import.meta.url)), 'hooks', 'modkit')
const [target, flag] = process.argv.slice(2)

const fail = (message, code = 2) => {
  console.error(`modkit: ${message}`)
  process.exit(code)
}

if (!target || (flag && flag !== '--check')) fail('usage: node install.mjs <plugin-dir> [--check]')
const plugin = resolve(target)
if (!existsSync(join(plugin, '.claude-plugin', 'plugin.json'))) fail(`${plugin} has no .claude-plugin/plugin.json`)
const dest = join(plugin, 'hooks', 'modkit')
if (dest === source) fail('the target is modkit itself')

const read = path => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const files = readdirSync(source)
const version = /export const VERSION = '([^']+)'/.exec(read(join(source, 'index.tsx')))?.[1] ?? '?'

if (flag === '--check') {
  const present = existsSync(dest) ? readdirSync(dest) : []
  const drift = [
    ...files.filter(file => !present.includes(file) || read(join(dest, file)) !== read(join(source, file))),
    ...present.filter(file => !files.includes(file)),
  ]
  if (drift.length > 0) fail(`${dest} differs from modkit ${version}: ${drift.join(', ')}`, 1)
  console.log(`modkit ${version}: ${dest} is up to date`)
} else {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  for (const file of files) writeFileSync(join(dest, file), read(join(source, file)))
  console.log(`modkit ${version} copied to ${dest}`)
}
