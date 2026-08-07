import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { spawn } from 'node:child_process'
import type { FileFingerprint, MediaValidation } from '../shared/types.js'

export const SUPPORTED_MEDIA_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.wav', '.aiff', '.aif', '.mp3', '.m4a'])
export type DirectoryBaseline = Record<string, { size: number; mtimeMs: number; birthtimeMs: number }>

export function contentType(path: string): string {
  return ({
    '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
    '.wav': 'audio/wav', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4'
  } as Record<string, string>)[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export async function snapshotDirectory(root: string, depth = 0): Promise<DirectoryBaseline> {
  const result: DirectoryBaseline = {}
  if (depth > 3) return result
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) { Object.assign(result, await snapshotDirectory(path, depth + 1)); continue }
    if (!entry.isFile() || !SUPPORTED_MEDIA_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
    try {
      const metadata = await stat(path)
      result[path] = { size: metadata.size, mtimeMs: metadata.mtimeMs, birthtimeMs: metadata.birthtimeMs }
    } catch { /* Files can disappear during a snapshot. */ }
  }
  return result
}

export function changedPaths(before: DirectoryBaseline, after: DirectoryBaseline): string[] {
  return Object.entries(after).filter(([path, value]) => !before[path] || before[path].size !== value.size || before[path].mtimeMs !== value.mtimeMs)
    .sort((left, right) => left[1].birthtimeMs - right[1].birthtimeMs || left[0].localeCompare(right[0])).map(([path]) => path)
}

function sleep(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }

export async function stableFingerprint(path: string, options: { probes?: number; delayMs?: number } = {}): Promise<FileFingerprint> {
  const probes = options.probes ?? 3; const delayMs = options.delayMs ?? 2_000
  let metadata = await stat(path)
  if (!metadata.isFile() || metadata.size <= 0) throw new Error(`${basename(path)} is empty or unavailable.`)
  for (let probe = 1; probe < probes; probe += 1) {
    await sleep(delayMs)
    const next = await stat(path)
    if (!next.isFile() || next.size <= 0 || next.size !== metadata.size || next.mtimeMs !== metadata.mtimeMs) throw new Error(`${basename(path)} is still changing.`)
    metadata = next
  }
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve))
  const after = await stat(path)
  if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) throw new Error(`${basename(path)} changed while it was fingerprinted.`)
  return { size: after.size, mtimeMs: after.mtimeMs, birthtimeMs: after.birthtimeMs, sha256: hash.digest('hex') }
}

async function command(path: string, args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${basename(path)} timed out.`)) }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim() || `${basename(path)} exited with ${code}.`)) })
  })
}

export async function ffprobeVersion(ffprobePath: string): Promise<string> {
  const result = await command(ffprobePath, ['-version'], 10_000)
  return result.stdout.split(/\r?\n/, 1)[0]?.trim() || 'unknown'
}

export async function validateMediaFile(path: string, ffprobePath: string, fingerprint: FileFingerprint): Promise<MediaValidation> {
  const checkedAt = new Date().toISOString()
  let version: string | null = null
  try {
    version = await ffprobeVersion(ffprobePath)
    const before = await stat(path)
    if (before.size !== fingerprint.size || before.mtimeMs !== fingerprint.mtimeMs) throw new Error('The file changed before validation.')
    const result = await command(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])
    const parsed = JSON.parse(result.stdout) as { streams?: Array<{ index?: unknown; codec_type?: unknown; codec_name?: unknown; duration?: unknown }>; format?: { duration?: unknown; format_name?: unknown } }
    const streams = (parsed.streams ?? []).filter((stream) => stream.codec_type === 'video' || stream.codec_type === 'audio')
    if (!streams.length) throw new Error('No supported video or audio stream was found.')
    const duration = Number(parsed.format?.duration ?? streams.map((stream) => Number(stream.duration)).find((value) => Number.isFinite(value) && value > 0))
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Media duration is missing or invalid.')
    const after = await stat(path)
    if (after.size !== fingerprint.size || after.mtimeMs !== fingerprint.mtimeMs) throw new Error('The file changed during validation.')
    return {
      checkedAt, ok: true, ffprobeVersion: version, durationSeconds: duration,
      streams: streams.map((stream) => ({ index: Number(stream.index) || 0, codecType: String(stream.codec_type), codecName: typeof stream.codec_name === 'string' ? stream.codec_name : null })),
      formatName: typeof parsed.format?.format_name === 'string' ? parsed.format.format_name : null, error: null
    }
  } catch (error) {
    return { checkedAt, ok: false, ffprobeVersion: version, durationSeconds: null, streams: [], formatName: null, error: error instanceof Error ? error.message : String(error) }
  }
}
