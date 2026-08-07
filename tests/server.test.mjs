import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore } from '../dist-server/main/config.js'
import { RecordLedger } from '../dist-server/main/ledger.js'
import { ApplicationRuntime } from '../dist-server/main/runtime.js'
import { AdministrationServer } from '../dist-server/main/server.js'

test('redacts state and rejects cross-origin or tokenless mutations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'movie-recorder-server-'))
  const config = await ConfigStore.open(directory); const { ledger } = await RecordLedger.open(directory)
  const runtime = new ApplicationRuntime(config, ledger, 'test', 'bootstrap-secret')
  const server = new AdministrationServer(runtime, '127.0.0.1', 8503)
  const origin = 'http://127.0.0.1:8503'; server.origin = origin
  try {
    const snapshot = runtime.snapshot(); assert.equal(Object.hasOwn(snapshot.config.descript, 'apiKey'), false); assert.equal(Object.hasOwn(snapshot.config.softron, 'password'), false)
    assert.throws(() => server.validateRequest({ method: 'POST', headers: { host: '127.0.0.1:8503', origin: 'https://attacker.example', 'content-type': 'application/json', 'x-bootstrap-token': 'bootstrap-secret' } }), (error) => error.code === 'invalid_origin')
    assert.throws(() => server.validateRequest({ method: 'POST', headers: { host: '127.0.0.1:8503', origin, 'content-type': 'application/json' } }), (error) => error.code === 'invalid_token')
    assert.doesNotThrow(() => server.validateRequest({ method: 'POST', headers: { host: '127.0.0.1:8503', origin, 'content-type': 'application/json', 'x-bootstrap-token': 'bootstrap-secret' } }))
  } finally { await runtime.shutdown(); await rm(directory, { recursive: true, force: true }) }
})
