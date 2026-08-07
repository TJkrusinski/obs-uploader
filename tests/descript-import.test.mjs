import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDescriptImportBody } from '../dist-server/main/descript-import.js'

const file = (name, role = 'iso', offset = 0) => ({
  id: name, sourceId: name, sourceLabel: name, role, localPath: `/tmp/${name}`, originalFilename: name, mediaKey: name,
  contentType: 'video/mp4', segmentIndex: 0, timelineOffsetSeconds: offset,
  fingerprint: { size: 100, mtimeMs: 1, birthtimeMs: 1, sha256: 'a'.repeat(64) }, stability: 'stable',
  validation: { checkedAt: new Date().toISOString(), ok: true, ffprobeVersion: 'ffprobe', durationSeconds: 10, streams: [{ index: 0, codecType: 'video', codecName: 'h264' }], formatName: 'mov', error: null },
  uploadStatus: 'pending', error: null
})
const record = (files) => ({ descriptProjectName: 'Gang', descriptFolder: 'Studio/26-08-07', files })

test('builds one synchronized Recording composition with Program ordered first', () => {
  const body = buildDescriptImportBody(record([file('Camera.mp4', 'iso', 1.25), file('Program.mp4', 'primary', 0)]))
  assert.equal(body.project_name, 'Gang')
  assert.equal(body.folder_name, 'Studio/26-08-07')
  assert.equal(body.team_access, 'edit')
  assert.equal('name' in body, false)
  assert.equal('folder_path' in body, false)
  assert.deepEqual(body.add_media['Softron Session'], { tracks: [{ media: 'Program.mp4', offset: 0 }, { media: 'Camera.mp4', offset: 1.25 }] })
  assert.deepEqual(body.add_compositions, [{ name: 'Recording', width: 1920, height: 1080, clips: [{ media: 'Softron Session' }] }])
})

test('retains ordered manual split clips and rejects unsafe gangs', () => {
  const first = file('Program-1.mov', 'primary', 0); first.segmentIndex = 0
  const second = file('Program-2.mov', 'primary', 30); second.segmentIndex = 1
  const body = buildDescriptImportBody(record([second, first]))
  assert.deepEqual(body.add_media['Softron Session'].tracks.map((track) => track.media), ['Program-1.mov', 'Program-2.mov'])
  assert.throws(() => buildDescriptImportBody(record([file('ISO.mov')])), /no primary/)
  const invalid = file('Program.mov', 'primary'); invalid.validation.ok = false
  assert.throws(() => buildDescriptImportBody(record([invalid])), /stable and valid/)
})
