import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { countVideoPackets, frameCountsWithinTolerance, reliableFrameCount, validateFinalizedVideo } from '../dist-electron/main/media-validation.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const run = promisify(execFile)
let directory
let validVideo
let fragmentedVideo

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'obs-upload-media-validation-'))
  validVideo = join(directory, 'complete.mp4')
  await run(ffmpegPath, [
    '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30',
    '-t', '1', '-c:v', 'mpeg4', '-q:v', '5',
    validVideo
  ])
  fragmentedVideo = join(directory, 'fragmented.mp4')
  await run(ffmpegPath, [
    '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30',
    '-t', '2', '-c:v', 'mpeg4', '-q:v', '5', '-g', '15',
    '-movflags', 'empty_moov+default_base_moof+frag_keyframe',
    fragmentedVideo
  ])
})

after(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

test('accepts a stable video whose frame count matches the XMEML declaration', async () => {
  const snapshot = await stat(validVideo)
  const result = await validateFinalizedVideo(validVideo, {
    frameCount: 30
  }, snapshot)
  assert.ok(result.durationSeconds >= 0.9)
  assert.equal(result.frameRate, 30)
  assert.equal(result.frameCount, 30)
  assert.equal(result.width, 160)
  assert.equal(result.height, 90)
  assert.equal(result.stats.size, snapshot.size)
})

test('ignores the bogus short nb_frames value emitted for vMix FFmpeg MP4 recordings', () => {
  const expectedFrames = 110_094
  const frameRate = 30
  const durationSeconds = expectedFrames / frameRate

  assert.equal(reliableFrameCount(250, durationSeconds, frameRate), null)
  assert.equal(reliableFrameCount(String(expectedFrames), durationSeconds, frameRate), expectedFrames)
})

test('counts muxed video packets without relying on the MP4 nb_frames field', async () => {
  assert.equal(await countVideoPackets(validVideo), 30)
})

test('follows every fragment when validating a segmented MP4 with no header frame total', async () => {
  const result = await validateFinalizedVideo(fragmentedVideo, {
    frameCount: 60
  }, await stat(fragmentedVideo))

  assert.equal(result.frameCount, 60)
})

test('accepts frame counts within three percent or the 100-frame minimum tolerance', async () => {
  assert.equal(frameCountsWithinTolerance(56_322, 56_323), true)
  assert.equal(frameCountsWithinTolerance(970, 1_000), true)
  assert.equal(frameCountsWithinTolerance(1_030, 1_000), true)
  assert.equal(frameCountsWithinTolerance(900, 1_000), true)
  assert.equal(frameCountsWithinTolerance(1_100, 1_000), true)
  assert.equal(frameCountsWithinTolerance(899, 1_000), false)
  assert.equal(frameCountsWithinTolerance(1_101, 1_000), false)
  assert.equal(frameCountsWithinTolerance(9_699, 10_000), false)
  assert.equal(frameCountsWithinTolerance(10_301, 10_000), false)

  const snapshot = await stat(validVideo)
  await validateFinalizedVideo(validVideo, { frameCount: 31 }, snapshot)
})

test('ignores declared video properties other than frame count', async () => {
  const snapshot = await stat(validVideo)
  await validateFinalizedVideo(validVideo, {
    durationSeconds: 2,
    frameRate: 25,
    frameCount: 30,
    width: 1920,
    height: 1080,
    audioChannels: 2
  }, snapshot)
})

test('rejects a frame-count difference greater than the applicable tolerance', async () => {
  const snapshot = await stat(validVideo)
  await assert.rejects(
    validateFinalizedVideo(validVideo, { frameCount: 131 }, snapshot),
    /contains 30 video frames, but the vMix XML declares 131 frames \(allowed difference: 100 frames or 3%, whichever is greater\)/
  )
})

test('rejects an incomplete container with unreadable video metadata', async () => {
  const path = join(directory, 'incomplete.mp4')
  await writeFile(path, 'not a finalized video container')
  await assert.rejects(validateFinalizedVideo(path, {}, await stat(path)), /readable, finalized video metadata/)
})

test('keeps a zero-byte output in the not-ready path', async () => {
  const path = join(directory, 'empty.mp4')
  await writeFile(path, '')
  await assert.rejects(
    validateFinalizedVideo(path, {}, await stat(path)),
    /still being written/
  )
})

test('rejects a file that changed after the stability snapshot', async () => {
  const path = join(directory, 'changed.mp4')
  await writeFile(path, 'initial')
  const snapshot = await stat(path)
  await appendFile(path, ' more bytes')
  await assert.rejects(validateFinalizedVideo(path, {}, snapshot), /changed after its stability probes/)
})
