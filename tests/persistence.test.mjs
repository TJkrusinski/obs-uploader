import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { ConfigStore, defaultConfig, validateConfig } from '../dist-server/main/config.js'
import { atomicWriteJson, readRecoverableJson, UnsupportedSchemaError } from '../dist-server/main/atomic-json.js'
import { RecordLedger } from '../dist-server/main/ledger.js'

const directories = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function temp() { const path = await mkdtemp(join(tmpdir(), 'movie-recorder-upload-')); directories.push(path); return path }

test('creates private JSON state and never exposes secrets in redacted configuration', async () => {
  const directory = await temp(); const config = await ConfigStore.open(directory)
  const complete = config.get(); complete.descript.apiKey = 'secret-key'; complete.softron.password = 'secret-password'
  await atomicWriteJson(config.path, complete, validateConfig)
  const reopened = await ConfigStore.open(directory); const redacted = reopened.redacted({ descript: null, softron: null })
  assert.equal(redacted.secrets.descriptApiKey.configured, true)
  assert.equal(JSON.stringify(redacted).includes('secret-key'), false)
  assert.equal(JSON.stringify(redacted).includes('secret-password'), false)
  assert.equal((await stat(directory)).mode & 0o077, 0)
  assert.equal((await stat(config.path)).mode & 0o077, 0)
})

test('recovers a corrupt active document from the last-known-good backup', async () => {
  const directory = await temp(); const path = join(directory, 'config.json')
  const first = defaultConfig(); await atomicWriteJson(path, first, validateConfig)
  const second = { ...first, server: { ...first.server, port: 9000 } }; await atomicWriteJson(path, second, validateConfig)
  await writeFile(path, '{broken')
  const loaded = await readRecoverableJson(path, validateConfig)
  assert.equal(loaded.recovered, true); assert.equal(loaded.value.server.port, 8503)
})

test('rejects future schema versions and corrupt ledgers without a backup', async () => {
  const directory = await temp(); const path = join(directory, 'config.json')
  await writeFile(path, JSON.stringify({ ...defaultConfig(), schemaVersion: 2 }))
  await assert.rejects(ConfigStore.open(directory), UnsupportedSchemaError)
  const other = await temp(); await writeFile(join(other, 'records.json'), 'not json')
  await assert.rejects(RecordLedger.open(other), /Neither records.json nor its backup/)
})

test('warns when config permissions are broader than owner-only', async () => {
  const directory = await temp(); const config = await ConfigStore.open(directory); await chmod(config.path, 0o644)
  const reopened = await ConfigStore.open(directory)
  assert.match(reopened.redacted({ descript: null, softron: null }).warnings[0], /broader than owner-only/)
  assert.doesNotMatch(await readFile(config.path, 'utf8'), /undefined/)
})
