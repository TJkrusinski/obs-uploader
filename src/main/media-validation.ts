import { execFile } from 'node:child_process'
import { promises as fs, type Stats } from 'node:fs'
import { createRequire } from 'node:module'
import { basename } from 'node:path'

const require = createRequire(import.meta.url)
const ffprobeInstaller = require('@ffprobe-installer/ffprobe') as { path?: string }
const installedFfmpegPath = require('ffmpeg-static') as string | null
const TAIL_DECODE_SECONDS = 3
const DURATION_TOLERANCE_SECONDS = 0.25

interface ProbeOutput {
  streams?: Array<{
    codec_type?: string
    duration?: string
    width?: number
    height?: number
    avg_frame_rate?: string
    r_frame_rate?: string
    nb_frames?: string
    channels?: number
  }>
  format?: { duration?: string }
}

export interface ExpectedVideoMetadata {
  durationSeconds: number
  frameRate?: number | null
  frameCount?: number | null
  width?: number | null
  height?: number | null
  audioChannels?: number | null
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
  const width = positiveNumber(video?.width)
  const height = positiveNumber(video?.height)
  const durationSeconds = positiveNumber(video?.duration) ?? positiveNumber(probe.format?.duration) ?? 0
  const frameRate = rationalNumber(video?.avg_frame_rate) ?? rationalNumber(video?.r_frame_rate) ?? 0
  const frameCount = positiveInteger(video?.nb_frames)
  const audioChannels = probe.streams
    ?.filter((stream) => stream.codec_type === 'audio')
    .reduce((total, stream) => total + (positiveInteger(stream.channels) ?? 0), 0) ?? 0
  if (!video || !width || !height || durationSeconds <= 0) {
    throw new Error(`${label} does not yet have readable, finalized video metadata.`)
  }
  if (!Number.isFinite(expected.durationSeconds) || expected.durationSeconds <= 0) {
    throw new Error(`The vMix timeline has an invalid expected duration for ${label}.`)
  }
  if (durationSeconds + DURATION_TOLERANCE_SECONDS < expected.durationSeconds) {
    throw new Error(
      `${label} is only ${durationSeconds.toFixed(3)} seconds long, but the vMix timeline requires ${expected.durationSeconds.toFixed(3)} seconds.`
    )
  }
  if (expected.frameRate && (!frameRate || Math.abs(frameRate - expected.frameRate) > Math.max(0.01, expected.frameRate * 0.0002))) {
    throw new Error(`${label} reports ${frameRate ? frameRate.toFixed(3) : 'no'} fps, but the vMix XML declares ${expected.frameRate.toFixed(3)} fps.`)
  }
  if (expected.frameCount && frameCount !== null && frameCount < expected.frameCount) {
    throw new Error(`${label} contains ${frameCount} video frames, but the vMix XML declares ${expected.frameCount} frames.`)
  }
  if (expected.width && expected.height && (width !== expected.width || height !== expected.height)) {
    throw new Error(`${label} is ${width}x${height}, but the vMix XML declares ${expected.width}x${expected.height}.`)
  }
  if (expected.audioChannels && audioChannels !== expected.audioChannels) {
    throw new Error(`${label} contains ${audioChannels} audio channels, but the vMix XML declares ${expected.audioChannels}.`)
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
