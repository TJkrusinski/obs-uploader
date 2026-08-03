import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDescriptImportBody } from '../dist-electron/main/descript-import.js'

function file(name, { role = 'iso', track = 0, clip = 0, start = 0, locationId = `track-${track}`, status = 'pending' } = {}) {
  return {
    id: `${name}-${track}-${clip}`,
    locationId,
    descriptMediaKey: name,
    contentType: 'video/mp4',
    fileSize: 100,
    sourceRole: role,
    segmentIndex: clip,
    manifestTrackIndex: track,
    manifestClipIndex: clip,
    timelineStartFrame: start,
    uploadStatus: status
  }
}

function session(recorderType, files, overrides = {}) {
  return {
    recorderType,
    descriptProjectName: 'Example',
    descriptFolderPath: 'Recordings/26-07-28',
    syncMode: recorderType === 'vmix' ? 'manifest' : 'unknown',
    timelineTimebase: recorderType === 'vmix' ? 30 : null,
    timelineNtsc: recorderType === 'vmix' ? true : null,
    files,
    ...overrides
  }
}

test('creates a Program-first multitrack sequence with normalized manifest offsets', () => {
  const body = buildDescriptImportBody(session('vmix', [
    file('Camera 1.mp4', { track: 0, start: 100 }),
    file('Program.mp4', { role: 'primary', track: 3, start: 100, locationId: 'program' }),
    file('Camera 2.mp4', { track: 1, start: 145 }),
    file('Excluded.mp4', { track: 2, status: 'excluded' })
  ]))
  assert.deepEqual(body.add_media['MultiCorder Sequence'], {
    tracks: [
      { media: 'Program.mp4', offset: 0 },
      { media: 'Camera 1.mp4', offset: 0 },
      { media: 'Camera 2.mp4', offset: 1.5015 }
    ]
  })
  assert.deepEqual(body.add_compositions, [{ name: 'Recording', width: 1920, height: 1080, clips: [{ media: 'MultiCorder Sequence' }] }])
  assert.equal(body.add_media['Excluded.mp4'], undefined)
})

test('keeps every split clip as its own sequence track at the correct timeline placement', () => {
  const body = buildDescriptImportBody(session('vmix', [
    file('Program part 1.mp4', { role: 'primary', track: 0, clip: 0, start: 0, locationId: 'program' }),
    file('Program part 2.mp4', { role: 'primary', track: 0, clip: 1, start: 18_000, locationId: 'program' }),
    file('Camera part 1.mp4', { track: 1, clip: 0, start: 15 }),
    file('Camera part 2.mp4', { track: 1, clip: 1, start: 18_015 })
  ], { timelineNtsc: false }))
  assert.deepEqual(body.add_media['MultiCorder Sequence'].tracks, [
    { media: 'Program part 1.mp4', offset: 0 },
    { media: 'Program part 2.mp4', offset: 600 },
    { media: 'Camera part 1.mp4', offset: 0.5 },
    { media: 'Camera part 2.mp4', offset: 600.5 }
  ])
})

test('renormalizes against included clips and supports explicit assumed-zero mode', () => {
  const files = [
    file('Excluded earliest.mp4', { track: 0, start: 100, status: 'excluded' }),
    file('Program.mp4', { role: 'primary', track: 1, start: 145, locationId: 'program' }),
    file('Camera.mp4', { track: 2, start: 175 })
  ]
  const exact = buildDescriptImportBody(session('vmix', files, { timelineNtsc: false }))
  assert.deepEqual(exact.add_media['MultiCorder Sequence'].tracks, [
    { media: 'Program.mp4', offset: 0 },
    { media: 'Camera.mp4', offset: 1 }
  ])
  const assumed = buildDescriptImportBody(session('vmix', files, { syncMode: 'assumed_zero', timelineTimebase: null, timelineNtsc: null }))
  assert.deepEqual(assumed.add_media['MultiCorder Sequence'].tracks.map((item) => item.offset), [0, 0])
})

test('rejects unknown timing, incomplete metadata, duplicate keys, and more than 14 physical clips', () => {
  const files = [file('Program.mp4', { role: 'primary', locationId: 'program' })]
  assert.throws(() => buildDescriptImportBody(session('vmix', files, { syncMode: 'unknown' })), /trustworthy/)
  assert.throws(() => buildDescriptImportBody(session('vmix', files, { timelineTimebase: null })), /incomplete/)
  assert.throws(() => buildDescriptImportBody(session('vmix', [...files, file('Program.mp4', { track: 1 })])), /duplicate/)
  assert.throws(() => buildDescriptImportBody(session('vmix', Array.from({ length: 15 }, (_, index) => file(`clip-${index}.mp4`, { role: index === 0 ? 'primary' : 'iso', track: index, locationId: index === 0 ? 'program' : `track-${index}` })))), /14-track/)
})

test('keeps OBS primary clips in the existing composition format', () => {
  const body = buildDescriptImportBody(session('obs', [
    file('Program.mp4', { role: 'primary' }),
    file('Other.mp4', { track: 1 })
  ]))
  assert.deepEqual(body.add_compositions, [{ name: 'Recording', width: 1920, height: 1080, clips: [{ media: 'Program.mp4' }] }])
  assert.equal(body.add_media['MultiCorder Sequence'], undefined)
})
