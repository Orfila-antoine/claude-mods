import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = join(dirname(fileURLToPath(import.meta.url)), 'hooks', 'modkit')
const [target, flag] = process.argv.slice(2)
const OWN = 'own.ts'
const START = '// modkit:roster'
const END = '// modkit:roster end'
const CONTRACT = './types/index.d.ts'

const fail = (message, code = 2) => {
  console.error(`modkit: ${message}`)
  process.exit(code)
}

if (!target || (flag && flag !== '--check')) fail('usage: node install.mjs <plugin-dir> [--check]')
const plugin = resolve(target)
const manifestPath = join(plugin, '.claude-plugin', 'plugin.json')
if (!existsSync(manifestPath)) fail(`${plugin} has no .claude-plugin/plugin.json`)
const dest = join(plugin, 'hooks', 'modkit')
const isSelf = resolve(dest).toLowerCase() === resolve(source).toLowerCase()

const read = path => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const quoted = name => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`)
const ownName = text => /plugin: '([^']+)'/.exec(text)?.[1]

const manifestText = read(manifestPath)
const manifest = JSON.parse(manifestText)
const name = manifest.name
if (typeof name !== 'string' || !name) fail(`${manifestPath} has no name`)
const files = readdirSync(source).filter(file => file !== OWN)
const version = /export const VERSION = '([^']+)'/.exec(read(join(source, 'index.tsx')))?.[1] ?? '?'
const members = [...read(join(source, 'roster.ts')).matchAll(/plugin: '([^']+)'/g)].map(found => found[1])
const template = read(join(source, OWN))
const own = template.replaceAll(`'${ownName(template)}'`, `'${name}'`)

const contractPath = join(plugin, manifest.types ?? CONTRACT)
const contract = existsSync(contractPath) ? read(contractPath) : ''
const marked = new RegExp(`${escape(START)}\\n[\\s\\S]*?${escape(END)}\\n?`)
const outside = contract.replace(marked, '')
const isOwnDeclared = new RegExp(`interface PluginState\\s*\\{[\\s\\S]*?(?:\\b${escape(name)}|'${escape(name)}'|"${escape(name)}")\\s*:`).test(outside)
if (isOwnDeclared && !/layout\s*:\s*ModkitLayout/.test(outside)) fail(`${contractPath} declares PluginState.${name}: add "layout: ModkitLayout" to it`)
const block = [
  START,
  read(join(source, 'contract.ts')).trimEnd(),
  '',
  "declare module 'claude-code' {",
  '  interface PluginState {',
  ...members.filter(member => !(isOwnDeclared && member === name)).map(member => `    ${quoted(member)}: { layout: ModkitLayout }`),
  '  }',
  '}',
  END,
  '',
].join('\n')
const separator = !contract || contract.endsWith('\n\n') ? '' : contract.endsWith('\n') ? '\n' : '\n\n'
const nextContract = marked.test(contract) ? contract.replace(marked, block) : `${contract}${separator}${block}`

if (flag === '--check') {
  const drift = []
  if (!isSelf) {
    const present = existsSync(dest) ? readdirSync(dest) : []
    drift.push(
      ...files.filter(file => !present.includes(file) || read(join(dest, file)) !== read(join(source, file))),
      ...present.filter(file => file !== OWN && !files.includes(file)),
    )
  }
  const ownPath = join(dest, OWN)
  if (!existsSync(ownPath) || ownName(read(ownPath)) !== name) drift.push(`${OWN} (not written for ${name})`)
  if (!manifest.types || contract !== nextContract) drift.push(`contract ${contractPath}`)
  if (drift.length > 0) fail(`${plugin} differs from modkit ${version}: ${drift.join(', ')}`, 1)
  console.log(`modkit ${version}: ${plugin} is up to date`)
} else {
  if (!isSelf) {
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    for (const file of files) writeFileSync(join(dest, file), read(join(source, file)))
    writeFileSync(join(dest, OWN), own)
  }
  mkdirSync(dirname(contractPath), { recursive: true })
  writeFileSync(contractPath, nextContract)
  if (!manifest.types) writeFileSync(manifestPath, manifestText.replace(/\n}\s*$/, `,\n  "types": "${CONTRACT}"\n}\n`))
  console.log(isSelf ? `modkit ${version}: contract of ${name} written` : `modkit ${version} copied to ${dest}`)
}
