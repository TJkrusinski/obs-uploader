import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDescriptImportBody } from '../dist-electron/main/descript-import.js'

function file(name, role = 'iso') {
  return {
    descriptMediaKey: name,
    contentType: 'video/mp4',
    fileSize: 100,
    sourceRole: role,
    uploadStatus: 'pending'
  }
}

function session(recorderType, files) {
  return {
    recorderType,
    descriptProjectName: 'Example',
    descriptFolderPath: 'Recordings/26-07-28',
    files
  }
}

test('creates one zero-offset multitrack sequence from every included vMix file', () => {
  const body = buildDescriptImportBody(session('vmix', [
    file('Camera 1.mp4', 'primary'),
    file('Camera 2.mp4'),
    { ...file('Excluded.mp4'), uploadStatus: 'excluded' }
  ]))

  assert.deepEqual(body.add_media['MultiCorder Sequence'], {
    tracks: [
      { media: 'Camera 1.mp4', offset: 0 },
      { media: 'Camera 2.mp4', offset: 0 }
    ]
  })
  assert.deepEqual(body.add_compositions, [{
    name: 'Recording',
    clips: [{ media: 'MultiCorder Sequence' }]
  }])
  assert.equal(body.add_media['Excluded.mp4'], undefined)
})

test('keeps OBS primary clips in the existing composition format', () => {
  const body = buildDescriptImportBody(session('obs', [
    file('Program.mp4', 'primary'),
    file('Other.mp4')
  ]))

  assert.deepEqual(body.add_compositions, [{
    name: 'Recording',
    clips: [{ media: 'Program.mp4' }]
  }])
  assert.equal(body.add_media['MultiCorder Sequence'], undefined)
})
