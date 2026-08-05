import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDescriptImportBody } from '../dist-electron/main/descript-import.js'

function file(name, { role = 'iso', status = 'pending' } = {}) {
  return {
    id: name,
    locationId: name,
    descriptMediaKey: name,
    contentType: 'video/mp4',
    fileSize: 100,
    sourceRole: role,
    segmentIndex: 0,
    uploadStatus: status
  }
}

function session(files, overrides = {}) {
  return {
    recorderType: 'obs',
    descriptProjectName: 'Example',
    descriptFolderPath: 'Recordings/26-07-28',
    files,
    ...overrides
  }
}

test('creates a Recording composition from included primary media', () => {
  const body = buildDescriptImportBody(session([
    file('Program.mp4', { role: 'primary' }),
    file('Other.mp4'),
    file('Excluded.mp4', { status: 'excluded' })
  ]))
  assert.deepEqual(body.add_compositions, [{ name: 'Recording', width: 1920, height: 1080, clips: [{ media: 'Program.mp4' }] }])
  assert.deepEqual(body.add_media['Program.mp4'], { content_type: 'video/mp4', file_size: 100 })
  assert.deepEqual(body.add_media['Other.mp4'], { content_type: 'video/mp4', file_size: 100 })
  assert.equal(body.add_media['Excluded.mp4'], undefined)
})

test('rejects unsupported legacy sessions', () => {
  assert.throws(() => buildDescriptImportBody(session([file('Program.mp4', { role: 'primary' })], { recorderType: 'legacy' })), /no longer supported/)
})

test('rejects missing primary media, duplicate keys, and invalid file sizes', () => {
  assert.throws(() => buildDescriptImportBody(session([file('Camera.mp4')])), /no primary/)
  assert.throws(() => buildDescriptImportBody(session([file('Program.mp4', { role: 'primary' }), file('Program.mp4')])), /duplicate/)
  const invalid = file('Program.mp4', { role: 'primary' })
  invalid.fileSize = 0
  assert.throws(() => buildDescriptImportBody(session([invalid])), /invalid file size/)
})
