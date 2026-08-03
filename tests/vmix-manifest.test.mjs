import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  actualFramesPerSecond,
  offsetSeconds,
  parseVmixManifestMediaNames,
  parseVmixTimeline,
  vmixProjectNameFromManifest
} from '../dist-electron/main/vmix-manifest.js'

function timelineXml({ timebase = 30, ntsc = 'FALSE', tracks }) {
  return `<xmeml><sequence><name>Test</name><rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate><media><video>${tracks.join('')}</video></media></sequence></xmeml>`
}

function track(clips) { return `<track>${clips.join('')}</track>` }
function clip({ id, start, end, path, fileId = `${id}-file`, reference = false, fileMetadata = '' }) {
  return `<clipitem id="${id}"><name>${id}</name><start>${start}</start><end>${end}</end>${reference
    ? `<file id="${fileId}" />`
    : `<file id="${fileId}"><name>${id}</name><pathurl>${path}</pathurl>${fileMetadata}</file>`}</clipitem>`
}

test('extracts physical clips, track order, rate, and decoded full paths from the example manifest', async () => {
  const xml = await readFile(new URL('../multicorder_example/MultiCorder - Timeline - 28 July 2026 - 11-53-49 AM.xml', import.meta.url), 'utf8')
  const timeline = parseVmixTimeline(xml)
  assert.deepEqual(timeline.rate, { timebase: 60, ntsc: true })
  assert.equal(timeline.clips.length, 4)
  assert.deepEqual(timeline.clips.map(({ trackIndex, clipIndex, startFrame }) => ({ trackIndex, clipIndex, startFrame })), [
    { trackIndex: 0, clipIndex: 0, startFrame: 0 },
    { trackIndex: 1, clipIndex: 0, startFrame: 0 },
    { trackIndex: 2, clipIndex: 0, startFrame: 0 },
    { trackIndex: 3, clipIndex: 0, startFrame: 2 }
  ])
  assert.deepEqual({
    sourceInFrame: timeline.clips[0].sourceInFrame,
    sourceOutFrame: timeline.clips[0].sourceOutFrame,
    mediaDurationFrames: timeline.clips[0].mediaDurationFrames,
    mediaRate: timeline.clips[0].mediaRate,
    mediaWidth: timeline.clips[0].mediaWidth,
    mediaHeight: timeline.clips[0].mediaHeight,
    mediaAudioChannels: timeline.clips[0].mediaAudioChannels
  }, {
    sourceInFrame: 0,
    sourceOutFrame: 32107,
    mediaDurationFrames: 32107,
    mediaRate: { timebase: 60, ntsc: true },
    mediaWidth: 1920,
    mediaHeight: 1080,
    mediaAudioChannels: 2
  })
  assert.match(timeline.clips[3].sourcePath.replace(/\\/g, '/'), /^C:\/Users\/MTS-PC\/Videos\/mts-recordings\//)
})

test('parses multiple clipitems without collapsing or sorting them', () => {
  const xml = timelineXml({ tracks: [track([
    clip({ id: 'second-in-manifest', start: 300, end: 600, path: 'file://localhost/D:/Camera%201-part2.mp4' }),
    clip({ id: 'first-on-timeline', start: 0, end: 300, path: 'file://localhost/D:/Camera%201-part1.mp4' })
  ])] })
  const parsed = parseVmixTimeline(xml)
  assert.deepEqual(parsed.clips.map((item) => [item.clipIndex, item.startFrame, item.sourcePath.replace(/\\/g, '/')]), [
    [0, 300, 'D:/Camera 1-part2.mp4'],
    [1, 0, 'D:/Camera 1-part1.mp4']
  ])
})

test('resolves self-closing XMEML file id references', () => {
  const definition = clip({
    id: 'one', start: 0, end: 30, path: 'file://localhost/D:/Camera.mp4', fileId: 'shared',
    fileMetadata: '<duration>30</duration><rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate><media><video><duration>30</duration><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></video><audio><channelcount>2</channelcount></audio></media>'
  })
  const reference = clip({ id: 'two', start: 30, end: 60, path: '', fileId: 'shared', reference: true })
  const parsed = parseVmixTimeline(timelineXml({ tracks: [track([definition, reference])] }))
  assert.equal(parsed.clips[1].pathUrl, 'file://localhost/D:/Camera.mp4')
  assert.equal(parsed.clips[1].mediaDurationFrames, 30)
  assert.deepEqual(parsed.clips[1].mediaRate, { timebase: 30, ntsc: false })
  assert.deepEqual([parsed.clips[1].mediaWidth, parsed.clips[1].mediaHeight, parsed.clips[1].mediaAudioChannels], [1920, 1080, 2])
})

test('decodes XML entities and URL escaping', () => {
  const xml = timelineXml({ tracks: [track([clip({ id: 'A &amp; B', start: 0, end: 30, path: 'file://localhost/C:/A%20%26%20B.mp4' })])] })
  assert.deepEqual(parseVmixManifestMediaNames(xml), ['A & B.mp4'])
})

test('calculates exact NTSC and integer-rate offsets', () => {
  assert.equal(actualFramesPerSecond({ timebase: 30, ntsc: true }), 30_000 / 1_001)
  assert.equal(actualFramesPerSecond({ timebase: 60, ntsc: true }), 60_000 / 1_001)
  assert.equal(actualFramesPerSecond({ timebase: 25, ntsc: false }), 25)
  assert.equal(offsetSeconds(45, 0, 30_000 / 1_001), 1.5015)
  assert.equal(offsetSeconds(50, 0, 25), 2)
  assert.equal(offsetSeconds(100, 100, 60_000 / 1_001), 0)
})

test('rejects incomplete, missing-rate, missing-start, fractional, and ambiguous rate documents', () => {
  assert.throws(() => parseVmixTimeline('<xmeml><sequence>'), /incomplete or invalid/)
  assert.throws(() => parseVmixTimeline('<xmeml><sequence><media><video><track/></video></media></sequence></xmeml>'), /frame rate|video tracks/)
  assert.throws(() => parseVmixTimeline(timelineXml({ tracks: [track([clip({ id: 'missing', start: '', end: 30, path: 'file://localhost/C:/one.mp4' })])] })), /clip start/)
  assert.throws(() => parseVmixTimeline(timelineXml({ tracks: [track([clip({ id: 'fractional', start: '1.5', end: 30, path: 'file://localhost/C:/one.mp4' })])] })), /clip start/)
  assert.throws(() => parseVmixTimeline(timelineXml({ ntsc: 'MAYBE', tracks: [track([clip({ id: 'bad-rate', start: 0, end: 30, path: 'file://localhost/C:/one.mp4' })])] })), /NTSC/)
})

test('uses the XML filename as the stable project key', () => {
  assert.equal(vmixProjectNameFromManifest('/recordings/MultiCorder - Timeline - 28 July 2026.xml'), 'MultiCorder - Timeline - 28 July 2026')
})
