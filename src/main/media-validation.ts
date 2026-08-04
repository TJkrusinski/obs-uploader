import { execFile } from 'node:child_process'
import { promises as fs, type Stats } from 'node:fs'
import { createRequire } from 'node:module'
import { basename } from 'node:path'

const require = createRequire(import.meta.url)
const ffprobeInstaller = require('@ffprobe-installer/ffprobe') as { path?: string }
const installedFfmpegPath = require('ffmpeg-static') as string | null
const TAIL_DECODE_SECONDS = 3
const DURATION_TOLERANCE_SECONDS = 0.25
const FRAME_COUNT_TOLERANCE_RATIO = 0.03
const MINIMUM_FRAME_COUNT_TOLERANCE = 100

interface ProbeOutput {
  streams?: Array<{
    codec_type?: string
    duration?: string
    width?: number
    height?: number
    avg_frame_rate?: string
    r_frame_rate?: string
    nb_frames?: string
    nb_read_packets?: string
    channels?: number
  }>
  format?: { duration?: string }
}

export interface ExpectedVideoMetadata {
  frameCount?: number | null
}

export interface FinalizedVideoValidation {
  stats: Stats
  durationSeconds: number
  width: number
  height: number
  frameRate: number
  frameCount: number | null
  audioChannels: number
}

function unpackedExecutablePath(path: string | null | undefined, label: string): string {
  if (!path) throw new Error(`${label} is unavailable, so recording finalization cannot be validated.`)
  return path.includes('app.asar.unpacked') ? path : path.replace('app.asar', 'app.asar.unpacked')
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && left.size === right.size && left.mtimeMs === right.mtimeMs
}

async function assertReadableSnapshot(path: string, snapshot: Stats): Promise<void> {
  const label = basename(path)
  let handle
  try {
    // This catches exclusive/denied access and unreadable tails, but it is not proof that
    // another process has closed the file because Node cannot request Windows share mode 0.
    handle = await fs.open(path, 'r')
    const opened = await handle.stat()
    if (!sameSnapshot(opened, snapshot) || opened.size === 0) {
      throw new Error('the file changed before it could be read')
    }
    const tail = Buffer.allocUnsafe(1)
    const { bytesRead } = await handle.read(tail, 0, 1, opened.size - 1)
    if (bytesRead !== 1) throw new Error('the final byte is not readable yet')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} cannot yet be opened and read as a complete file: ${message}`)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function lastCommandDetail(stderr: string): string {
  return stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
}

function runExecutable(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = lastCommandDetail(stderr)
        reject(new Error(detail || error.message))
        return
      }
      resolve(stdout)
    })
  })
}

function positiveNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function positiveInteger(value: unknown): number | null {
  const number = positiveNumber(value)
  return number !== null && Number.isSafeInteger(number) ? number : null
}

function rationalNumber(value: unknown): number | null {
  if (typeof value !== 'string') return positiveNumber(value)
  const [numeratorValue, denominatorValue] = value.split('/')
  const numerator = Number(numeratorValue)
  const denominator = denominatorValue === undefined ? 1 : Number(denominatorValue)
  return Number.isFinite(numerator) && Number.isFinite(denominator) && numerator > 0 && denominator > 0
    ? numerator / denominator
    : null
}

/**
 * Some MP4 muxers, including vMix's FFmpeg MP4 mode, can leave nb_frames with
 * a small fragment/sample-table count even though stream duration and rate are
 * correct. Only treat nb_frames as a real decoded-frame count when it agrees
 * with those independent fields. A suspect count triggers a packet-counting
 * probe, while duration coverage and the tail decode remain separate checks.
 */
export function reliableFrameCount(
  reportedFrameCount: unknown,
  durationSeconds: number,
  frameRate: number
): number | null {
  const frameCount = positiveInteger(reportedFrameCount)
  if (frameCount === null || durationSeconds <= 0 || frameRate <= 0) return null
  const durationDerivedFrames = durationSeconds * frameRate
  const toleranceFrames = Math.max(2, frameRate * DURATION_TOLERANCE_SECONDS)
  return Math.abs(frameCount - durationDerivedFrames) <= toleranceFrames ? frameCount : null
}

export function frameCountsWithinTolerance(actualFrameCount: number, expectedFrameCount: number): boolean {
  const toleranceFrames = Math.max(MINIMUM_FRAME_COUNT_TOLERANCE, expectedFrameCount * FRAME_COUNT_TOLERANCE_RATIO)
  return Math.abs(actualFrameCount - expectedFrameCount) <= toleranceFrames
}

/**
 * Counts demuxed packets instead of trusting the MP4 stream's nb_frames field.
 * For vMix's H.264/H.265 MP4 output, each selected video packet represents one
 * encoded frame. This scans the file but does not incur a full video decode.
 */
export async function countVideoPackets(path: string): Promise<number> {
  const ffprobePath = unpackedExecutablePath(ffprobeInstaller.path, 'ffprobe')
  const stdout = await runExecutable(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_packets',
    '-show_entries', 'stream=nb_read_packets',
    '-of', 'json',
    path
  ])
  const probe = JSON.parse(stdout) as ProbeOutput
  const packetCount = positiveInteger(probe.streams?.[0]?.nb_read_packets)
  if (packetCount === null) throw new Error('ffprobe did not return a video packet count')
  return packetCount
}

/**
 * Verifies that a recording container is complete enough to upload without modifying it.
 * The caller supplies the snapshot captured by the preceding stability probes so changes
 * that occur during metadata inspection or tail decoding are also detected.
 */
export async function validateFinalizedVideo(
  path: string,
  expected: ExpectedVideoMetadata,
  stableSnapshot: Stats
): Promise<FinalizedVideoValidation> {
  const label = basename(path)
  const before = await fs.stat(path)
  if (!sameSnapshot(before, stableSnapshot) || before.size === 0) {
    throw new Error(`${label} changed after its stability probes and is still being written.`)
  }
  await assertReadableSnapshot(path, stableSnapshot)

  const ffprobePath = unpackedExecutablePath(ffprobeInstaller.path, 'ffprobe')
  let probe: ProbeOutput
  try {
    const stdout = await runExecutable(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,duration,width,height,avg_frame_rate,r_frame_rate,nb_frames,channels:format=duration',
      '-of', 'json',
      path
    ])
    probe = JSON.parse(stdout) as ProbeOutput
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} does not yet have readable, finalized video metadata: ${message}`)
  }

  const video = probe.streams?.find((stream) => stream.codec_type === 'video')
  const width = positiveNumber(video?.width) ?? 0
  const height = positiveNumber(video?.height) ?? 0
  const durationSeconds = positiveNumber(video?.duration) ?? positiveNumber(probe.format?.duration) ?? 0
  const frameRate = rationalNumber(video?.avg_frame_rate) ?? rationalNumber(video?.r_frame_rate) ?? 0
  const reportedFrameCount = positiveInteger(video?.nb_frames)
  let frameCount = reliableFrameCount(reportedFrameCount, durationSeconds, frameRate)
  const audioChannels = probe.streams
    ?.filter((stream) => stream.codec_type === 'audio')
    .reduce((total, stream) => total + (positiveInteger(stream.channels) ?? 0), 0) ?? 0
  if (!video || durationSeconds <= 0) {
    throw new Error(`${label} does not yet have readable, finalized video metadata.`)
  }
  if (expected.frameCount && frameCount === null) {
    try {
      frameCount = await countVideoPackets(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${label} has no reliable container frame count, and ffprobe could not count its muxed video packets: ${message}`)
    }
  }
  if (expected.frameCount && frameCount !== null && !frameCountsWithinTolerance(frameCount, expected.frameCount)) {
    throw new Error(
      `${label} contains ${frameCount} video frames, but the vMix XML declares ${expected.frameCount} frames (allowed difference: 100 frames or 3%, whichever is greater).`
    )
  }

  const ffmpegPath = unpackedExecutablePath(installedFfmpegPath, 'ffmpeg')
  const tailDuration = Math.min(TAIL_DECODE_SECONDS, durationSeconds)
  const tailStart = Math.max(0, durationSeconds - tailDuration)
  try {
    const progress = await runExecutable(ffmpegPath, [
      '-nostdin', '-v', 'error', '-xerror',
      '-ss', tailStart.toFixed(6),
      '-i', path,
      '-t', tailDuration.toFixed(6),
      '-map', '0:v:0', '-an', '-sn', '-dn',
      '-progress', 'pipe:1', '-nostats',
      '-f', 'null', '-'
    ])
    const decodedFrames = [...progress.matchAll(/^frame=(\d+)$/gm)].reduce((latest, match) => Number(match[1]) || latest, 0)
    if (decodedFrames === 0) throw new Error('no video frames were decoded near the reported end')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} failed its final video-tail decode and may still be incomplete: ${message}`)
  }

  const after = await fs.stat(path)
  if (!sameSnapshot(after, stableSnapshot)) {
    throw new Error(`${label} changed during finalization validation and is still being written.`)
  }
  return { stats: after, durationSeconds, width, height, frameRate, frameCount, audioChannels }
}
