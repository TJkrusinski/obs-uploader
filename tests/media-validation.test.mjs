import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { countVideoPackets, reliableFrameCount, validateFinalizedVideo } from '../dist-electron/main/media-validation.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const run = promisify(execFile)
let directory
let validVideo
let audioLongerVideo
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
  audioLongerVideo = join(directory, 'audio-outlasts-video.mp4')
  await run(ffmpegPath, [
    '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
    '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac',
    audioLongerVideo
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

test('accepts a stable video whose metadata and decoded tail cover the XMEML duration', async () => {
  const snapshot = await stat(validVideo)
  const result = await validateFinalizedVideo(validVideo, {
    durationSeconds: 0.9,
    frameRate: 30,
    frameCount: 30,
    width: 160,
    height: 90
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
    durationSeconds: 1.9,
    frameRate: 30,
    frameCount: 60,
    width: 160,
    height: 90
  }, await stat(fragmentedVideo))

  assert.equal(result.frameCount, 60)
})

test('rejects a video shorter than the physical XMEML clip duration', async () => {
  const snapshot = await stat(validVideo)
  await assert.rejects(validateFinalizedVideo(validVideo, { durationSeconds: 2 }, snapshot), /timeline requires 2\.000 seconds/)
})

test('does not mistake a longer audio stream for complete video duration', async () => {
  const snapshot = await stat(audioLongerVideo)
  await assert.rejects(validateFinalizedVideo(audioLongerVideo, { durationSeconds: 1.8 }, snapshot), /timeline requires 1\.800 seconds/)
})

test('rejects ffprobe metadata that does not align with the vMix XML declaration', async () => {
  const snapshot = await stat(validVideo)
  await assert.rejects(
    validateFinalizedVideo(validVideo, { durationSeconds: 0.9, frameRate: 25 }, snapshot),
    /reports 30\.000 fps, but the vMix XML declares 25\.000 fps/
  )
  await assert.rejects(
    validateFinalizedVideo(validVideo, { durationSeconds: 0.9, frameCount: 31 }, snapshot),
    /contains 30 video frames, but the vMix XML declares 31 frames/
  )
  await assert.rejects(
    validateFinalizedVideo(validVideo, { durationSeconds: 0.9, width: 1920, height: 1080 }, snapshot),
    /is 160x90, but the vMix XML declares 1920x1080/
  )
  const audioSnapshot = await stat(audioLongerVideo)
  await assert.rejects(
    validateFinalizedVideo(audioLongerVideo, { durationSeconds: 0.9, audioChannels: 2 }, audioSnapshot),
    /contains 1 audio channels, but the vMix XML declares 2/
  )
})

test('rejects an incomplete container with unreadable video metadata', async () => {
  const path = join(directory, 'incomplete.mp4')
  await writeFile(path, 'not a finalized video container')
  await assert.rejects(validateFinalizedVideo(path, { durationSeconds: 1 }, await stat(path)), /readable, finalized video metadata/)
})

test('keeps a zero-byte output in the not-ready path', async () => {
  const path = join(directory, 'empty.mp4')
  await writeFile(path, '')
  await assert.rejects(
    validateFinalizedVideo(path, { durationSeconds: 1 }, await stat(path)),
    /still being written/
  )
})

test('rejects a file that changed after the stability snapshot', async () => {
  const path = join(directory, 'changed.mp4')
  await writeFile(path, 'initial')
  const snapshot = await stat(path)
  await appendFile(path, ' more bytes')
  await assert.rejects(validateFinalizedVideo(path, { durationSeconds: 1 }, snapshot), /changed after its stability probes/)
})
