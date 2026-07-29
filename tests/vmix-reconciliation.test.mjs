import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectVmixProjectContents } from '../dist-electron/main/vmix-reconciliation.js'

const files = [
  { id: 'one', descriptMediaKey: 'Camera 1.mp4', uploadStatus: 'pending' },
  { id: 'two', descriptMediaKey: 'Camera 2.mp4', uploadStatus: 'pending' },
  { id: 'excluded', descriptMediaKey: 'Excluded.mp4', uploadStatus: 'excluded' }
]

test('reports which manifest files already exist in a project', () => {
  const result = inspectVmixProjectContents(files, {
    media_files: { 'camera 1.mp4': { type: 'video' } },
    compositions: []
  })

  assert.deepEqual(result.uploadedFileIds, ['one'])
  assert.equal(result.complete, false)
})

test('requires all listed files, the sequence, and Recording composition', () => {
  const result = inspectVmixProjectContents(files, {
    media_files: {
      'Camera 1.mp4': { type: 'video' },
      'Camera 2.mp4': { type: 'video' },
      'MultiCorder Sequence': { type: 'sequence' }
    },
    compositions: [{ id: 'composition', name: 'Recording' }]
  })

  assert.deepEqual(result.uploadedFileIds, ['one', 'two'])
  assert.equal(result.complete, true)
})
