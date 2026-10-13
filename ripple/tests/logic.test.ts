import { expect, test } from 'claude-code/testing'

import { editColor, editStats, foundIn, isRemovedBy, isSensitive, relativeTo, removedPaths, treeLines } from '../hooks/logic'

test('edit stats come from the patch, a new file from its content', () => {
  expect(editStats({ structuredPatch: [{ lines: ['+a', '+b', '-c', ' d'] }] })).toEqual({ added: 2, removed: 1, isNew: false })
  expect(editStats({ type: 'create', content: 'a\nb\nc', structuredPatch: [] })).toEqual({ added: 3, removed: 0, isNew: true })
  expect(editStats(undefined)).toEqual({ added: 0, removed: 0, isNew: false })
})

test('a file takes its color from its share of added lines', () => {
  expect(editColor({ added: 5, removed: 0 })).toBe('#50d550')
  expect(editColor({ added: 0, removed: 5 })).toBe('#d55050')
  expect(editColor({ added: 1, removed: 1 })).toBe('#d5d550')
  expect(editColor({ added: 0, removed: 9, isNew: true })).toBe('#50d550')
  expect(editColor({ added: 5, removed: 0, isGone: true })).toBe('gray')
})

test('a removal names the files it takes away', () => {
  const gone = removedPaths('cd /c/repo && rm -f src/token.ts; git rm -r "api" | Remove-Item C:\\repo\\old.ts')
  expect(gone).toEqual(['src/token.ts', 'api', 'c:/repo/old.ts'])
  expect(isRemovedBy('C:/repo/src/token.ts', gone)).toBe(true)
  expect(isRemovedBy('C:/repo/api/client.ts', gone)).toBe(true)
  expect(isRemovedBy('C:/repo/old.ts', gone)).toBe(true)
  expect(isRemovedBy('C:/repo/src/auth.ts', gone)).toBe(false)
  expect(removedPaths('echo rm is fun; grep rmdir x')).toEqual([])
})

test('sensitive files are recognised', () => {
  expect(isSensitive('C:\\repo\\.env.local')).toBe(true)
  expect(isSensitive('/home/me/.claude/settings.json')).toBe(true)
  expect(isSensitive('/repo/.claude/agents/juge.md')).toBe(true)
  expect(isSensitive('/repo/.github/workflows/ci.yml')).toBe(true)
  expect(isSensitive('/repo/CLAUDE.md')).toBe(true)
  expect(isSensitive('/repo/certs/server.pem')).toBe(true)
  expect(isSensitive('/repo/.gitattributes')).toBe(true)
  expect(isSensitive('/repo/src/token.ts')).toBe(false)
  expect(isSensitive('/repo/src/keyboard.ts')).toBe(false)
})

test('a search group points at the first hit of its last successful grep', () => {
  const calls = [
    { tool: 'Read', isErrored: false, output: {} },
    { tool: 'Grep', isErrored: false, output: { content: 'C:\\repo\\src\\auth.ts:42:const token = readToken()\nsrc/b.ts:7:x' } },
  ]
  expect(foundIn(calls)).toBe('src/auth.ts:42')
  expect(foundIn([{ tool: 'Grep', isErrored: false, output: { filenames: ['/r/src/one.ts'] } }])).toBe('src/one.ts')
  expect(foundIn([{ tool: 'Grep', isErrored: false, output: { filenames: ['/a.ts', '/b.ts'] } }])).toBeNull()
})

test('paths become a tree, each folder once', () => {
  expect(treeLines(['src/token.ts', 'api/client.ts', 'src/auth.ts'])).toEqual([
    { depth: 0, name: 'api/', path: null },
    { depth: 1, name: 'client.ts', path: 'api/client.ts' },
    { depth: 0, name: 'src/', path: null },
    { depth: 1, name: 'auth.ts', path: 'src/auth.ts' },
    { depth: 1, name: 'token.ts', path: 'src/token.ts' },
  ])
  expect(relativeTo('C:/repo', 'C:\\repo\\src\\a.ts')).toBe('src/a.ts')
  expect(relativeTo(null, '/x/y/z.ts')).toBe('x/y/z.ts')
})
