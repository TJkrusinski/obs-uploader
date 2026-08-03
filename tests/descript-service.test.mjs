import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { DescriptService } from '../dist-electron/main/services.js'

let directory
before(async () => { directory = await mkdtemp(join(tmpdir(), 'obs-upload-service-')) })
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

function makeSession(path, stats, recorderType = 'obs') {
  return {
    id: 'session', recorderType, status: 'ready', uploadExcluded: false, descriptProjectName: 'Example', descriptFolderPath: 'Recordings',
    descriptProjectId: null, descriptJobId: null, descriptProjectUrl: null, syncMode: recorderType === 'vmix' ? 'manifest' : 'unknown',
    timelineTimebase: recorderType === 'vmix' ? 30 : null, timelineNtsc: recorderType === 'vmix' ? false : null,
    manifestPath: null, manifestHash: null, importAttemptId: null, importPayloadHash: null,
    files: [{
      id: 'file', locationId: 'program', sourceLabel: 'Program', sourceRole: 'primary', localPath: path,
      originalFilename: 'Program.mp4', descriptMediaKey: 'Program.mp4', contentType: 'video/mp4', fileSize: stats.size,
      modifiedAt: stats.mtime.toISOString(), segmentIndex: 0, manifestTrackIndex: recorderType === 'vmix' ? 0 : null,
      manifestClipIndex: recorderType === 'vmix' ? 0 : null, manifestClipId: null, timelineStartFrame: recorderType === 'vmix' ? 0 : null,
      timelineEndFrame: recorderType === 'vmix' ? 30 : null, stabilityStatus: 'stable', uploadStatus: 'pending', errorMessage: null
    }]
  }
}

class FakeLedger {
  constructor(session) { this.session = session; this.fileStates = []; this.activities = [] }
  getSession() { return this.session }
  getPendingSessions() { return [this.session] }
  getSessions() { return [this.session] }
  updateSession(_id, values) { Object.assign(this.session, values) }
  updateFile(id, values) {
    Object.assign(this.session.files.find((file) => file.id === id), values)
    if (values.uploadStatus) this.fileStates.push(values.uploadStatus)
  }
  addActivity(kind, message) { this.activities.push({ kind, message }) }
}

const settings = {
  get: () => ({ uploadsEnabled: true }),
  getDescriptToken: async () => 'token'
}

test('marks a successful PUT as transferred and persists the import attempt before processing', async () => {
  const path = join(directory, 'Program.mp4')
  await writeFile(path, 'video-bytes')
  const session = makeSession(path, await stat(path))
  const ledger = new FakeLedger(session)
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ input: String(input), init })
    if (String(input).includes('/jobs/import/project_media')) {
      return new Response(JSON.stringify({
        job_id: 'job', project_id: 'project', project_url: 'https://web.descript.com/project',
        upload_urls: { 'Program.mp4': { upload_url: 'https://upload.example/program' } }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('', { status: 200 })
  }
  try {
    await new DescriptService(settings, ledger).upload(session)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(ledger.fileStates, ['uploading', 'transferred'])
  assert.equal(session.status, 'processing')
  assert.equal(session.descriptJobId, 'job')
  assert.match(session.importAttemptId, /^[0-9a-f-]{36}$/)
  assert.match(session.importPayloadHash, /^[0-9a-f]{64}$/)
  assert.equal(requests[1].init.headers['Content-Type'], 'application/octet-stream')
  assert.equal(requests[1].init.headers['Content-Length'], String(session.files[0].fileSize))
})

test('retries a transient PUT against the original signed URL', async () => {
  const path = join(directory, 'Retry.mp4')
  await writeFile(path, 'video')
  const session = makeSession(path, await stat(path))
  const ledger = new FakeLedger(session)
  const originalFetch = globalThis.fetch
  let puts = 0
  globalThis.fetch = async (input) => {
    if (String(input).includes('/jobs/import/project_media')) {
      return new Response(JSON.stringify({
        job_id: 'retry-job', project_id: 'retry-project',
        upload_urls: { 'Program.mp4': { upload_url: 'https://upload.example/retry' } }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    puts += 1
    return new Response('', { status: puts === 1 ? 503 : 200 })
  }
  try {
    await new DescriptService(settings, ledger).upload(session)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(puts, 2)
  assert.equal(session.files[0].uploadStatus, 'transferred')
})

test('promotes transferred files only after a stopped successful job creates Recording', async () => {
  const path = join(directory, 'Processed.mp4')
  await writeFile(path, 'video')
  const session = makeSession(path, await stat(path))
  session.status = 'processing'
  session.descriptJobId = 'job'
  session.files[0].uploadStatus = 'transferred'
  const ledger = new FakeLedger(session)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => String(input).includes('/v1/jobs/job')
    ? new Response(JSON.stringify({
        job_state: 'stopped', result: {
          status: 'success', media_status: { 'Program.mp4': { status: 'success' } }, created_compositions: [{ name: 'Recording' }]
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  settings.get = () => ({ uploadsEnabled: false })
  try {
    await new DescriptService(settings, ledger).reconcile()
  } finally {
    globalThis.fetch = originalFetch
    settings.get = () => ({ uploadsEnabled: true })
  }
  assert.equal(session.files[0].uploadStatus, 'uploaded')
  assert.equal(session.status, 'completed')
})

test('fails safely when Descript omits a physical upload target', async () => {
  const path = join(directory, 'Missing-target.mp4')
  await writeFile(path, 'video')
  const session = makeSession(path, await stat(path))
  const ledger = new FakeLedger(session)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    job_id: 'incomplete-job', project_id: 'incomplete-project', upload_urls: {}
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  try {
    await assert.rejects(new DescriptService(settings, ledger).upload(session), /did not return upload targets/)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(session.status, 'failed')
  assert.equal(session.descriptJobId, 'incomplete-job')
})

test('aborts when a source changes after the job is created but before PUT', async () => {
  const path = join(directory, 'Changed-source.mp4')
  await writeFile(path, 'original')
  const session = makeSession(path, await stat(path))
  const ledger = new FakeLedger(session)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    if (String(input).includes('/jobs/import/project_media')) {
      await writeFile(path, 'changed-and-longer')
      return new Response(JSON.stringify({
        job_id: 'changed-job', project_id: 'changed-project',
        upload_urls: { 'Program.mp4': { upload_url: 'https://upload.example/changed' } }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    throw new Error('PUT should not begin for a changed source.')
  }
  try {
    await assert.rejects(new DescriptService(settings, ledger).upload(session), /changed before upload/)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(session.status, 'needs_review')
  assert.equal(session.files[0].uploadStatus, 'failed')
})

test('invalidates a vMix session when the manifest hash changes before upload', async () => {
  const path = join(directory, 'Manifest-source.mp4')
  const manifestPath = join(directory, 'timeline.xml')
  await writeFile(path, 'video')
  await writeFile(manifestPath, '<xmeml>first</xmeml>')
  const session = makeSession(path, await stat(path), 'vmix')
  session.manifestPath = manifestPath
  session.manifestHash = createHash('sha256').update('<xmeml>first</xmeml>').digest('hex')
  await writeFile(manifestPath, '<xmeml>changed</xmeml>')
  const ledger = new FakeLedger(session)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('No import request should be created for a changed manifest.') }
  try {
    await new DescriptService(settings, ledger).upload(session)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(session.status, 'needs_review')
  assert.match(session.errorMessage, /manifest changed/)
})

test('does not complete a job that omitted the Recording composition', async () => {
  const path = join(directory, 'No-composition.mp4')
  await writeFile(path, 'video')
  const session = makeSession(path, await stat(path))
  session.status = 'processing'
  session.descriptJobId = 'job-without-composition'
  session.files[0].uploadStatus = 'transferred'
  const ledger = new FakeLedger(session)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => String(input).includes('/v1/jobs/job-without-composition')
    ? new Response(JSON.stringify({
        job_state: 'stopped', result: {
          status: 'success', media_status: { 'Program.mp4': { status: 'success' } }, created_compositions: []
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  settings.get = () => ({ uploadsEnabled: false })
  try {
    await new DescriptService(settings, ledger).reconcile()
  } finally {
    globalThis.fetch = originalFetch
    settings.get = () => ({ uploadsEnabled: true })
  }
  assert.equal(session.status, 'failed')
  assert.equal(session.files[0].uploadStatus, 'failed')
  assert.match(session.errorMessage, /Recording composition/)
})
