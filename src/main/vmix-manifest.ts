import { basename, extname } from 'node:path'
import { XMLParser } from 'fast-xml-parser'

const MAX_XML_BYTES = 10 * 1024 * 1024

export interface VmixTimelineRate {
  timebase: number
  ntsc: boolean
}

export interface VmixTimelineClip {
  trackIndex: number
  clipIndex: number
  clipId: string | null
  displayName: string
  pathUrl: string
  sourcePath: string
  startFrame: number
  endFrame: number
  sourceInFrame: number | null
  sourceOutFrame: number | null
  mediaDurationFrames: number | null
  mediaRate: VmixTimelineRate | null
  mediaWidth: number | null
  mediaHeight: number | null
  mediaAudioChannels: number | null
}

export interface VmixTimeline {
  rate: VmixTimelineRate
  clips: VmixTimelineClip[]
}

type XmlNode = Record<string, unknown>

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => name === 'track' || name === 'clipitem'
})

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

function asNode(value: unknown): XmlNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as XmlNode : undefined
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) {
    throw new Error(`The vMix timeline has an invalid ${label} value.`)
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`The vMix timeline has an invalid ${label} value.`)
  return number
}

function optionalInteger(value: unknown, label: string): number | null {
  return value === undefined || value === null ? null : requiredInteger(value, label)
}

function parseRate(value: unknown, label: string): VmixTimelineRate {
  const rate = asNode(value)
  if (!rate) throw new Error(`The vMix timeline does not declare a ${label}.`)
  const timebase = requiredInteger(rate.timebase, `${label} timebase`)
  if (timebase <= 0 || timebase > 240) throw new Error(`Unsupported vMix timebase: ${timebase}.`)
  const ntscValue = String(rate.ntsc ?? '').trim().toUpperCase()
  if (ntscValue !== 'TRUE' && ntscValue !== 'FALSE') {
    throw new Error(`The vMix timeline has an invalid ${label} NTSC rate flag.`)
  }
  return { timebase, ntsc: ntscValue === 'TRUE' }
}

function optionalRate(node: XmlNode, label: string): VmixTimelineRate | null {
  return node.rate === undefined ? null : parseRate(node.rate, label)
}

function sameRate(left: VmixTimelineRate, right: VmixTimelineRate): boolean {
  return left.timebase === right.timebase && left.ntsc === right.ntsc
}

function assertSafeDepth(xml: string): void {
  let depth = 0
  for (const match of xml.matchAll(/<\s*(\/)?\s*([A-Za-z_][\w:.-]*)\b[^>]*>/g)) {
    if (match[1]) depth -= 1
    else if (!/\/\s*>$/.test(match[0])) depth += 1
    if (depth > 128) throw new Error('The vMix MultiCorder XML exceeds the maximum element depth.')
    if (depth < 0) throw new Error('The vMix MultiCorder XML is malformed.')
  }
  if (depth !== 0) throw new Error('The vMix MultiCorder XML is malformed.')
}

function collectFileDefinitions(node: unknown, result = new Map<string, XmlNode>()): Map<string, XmlNode> {
  if (!node || typeof node !== 'object') return result
  if (Array.isArray(node)) {
    for (const child of node) collectFileDefinitions(child, result)
    return result
  }
  const record = node as XmlNode
  for (const fileValue of asArray(record.file as XmlNode | XmlNode[] | undefined)) {
    const file = asNode(fileValue)
    const id = typeof file?.['@_id'] === 'string' ? file['@_id'] : null
    const pathUrl = typeof file?.pathurl === 'string' ? file.pathurl : null
    if (id && pathUrl) {
      const existing = result.get(id)
      if (existing && existing.pathurl !== pathUrl) throw new Error(`The vMix timeline defines file id ${id} more than once.`)
      result.set(id, file!)
    }
  }
  for (const value of Object.values(record)) collectFileDefinitions(value, result)
  return result
}

function decodePercentEscapes(value: string, label: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error(`The vMix timeline contains invalid URL escaping in ${label}.`)
  }
}

export function sourcePathFromVmixPathUrl(pathUrl: string): string {
  const trimmed = pathUrl.trim()
  if (!trimmed) throw new Error('The vMix timeline contains an empty media path.')
  if (!/^file:/i.test(trimmed)) return decodePercentEscapes(trimmed, trimmed)
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`The vMix timeline contains an invalid file URL: ${trimmed}`)
  }
  if (url.protocol !== 'file:') throw new Error(`Unsupported vMix media URL: ${trimmed}`)
  const host = decodePercentEscapes(url.hostname, trimmed)
  let path = decodePercentEscapes(url.pathname, trimmed)
  if (host && host.toLowerCase() !== 'localhost') path = `//${host}${path}`
  else if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
  if (process.platform === 'win32') path = path.replace(/\//g, '\\')
  if (!path) throw new Error(`The vMix timeline contains an invalid media path: ${trimmed}`)
  return path
}

export function filenameFromVmixPath(pathUrlOrPath: string): string {
  const value = /^file:/i.test(pathUrlOrPath) ? sourcePathFromVmixPathUrl(pathUrlOrPath) : pathUrlOrPath
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  const filename = normalized.slice(normalized.lastIndexOf('/') + 1).trim()
  if (!filename) throw new Error(`The vMix timeline contains an invalid media path: ${pathUrlOrPath}`)
  return filename
}

function displayName(clip: XmlNode, file: XmlNode, sourcePath: string): string {
  const declared = [clip.name, file.name].find((value) => typeof value === 'string' && value.trim())
  if (typeof declared === 'string') return declared.trim()
  const filename = filenameFromVmixPath(sourcePath)
  const stem = filename.slice(0, filename.length - extname(filename).length)
  return stem
    .replace(/^MultiCorder\d*\s*-\s*/i, '')
    .replace(/\s+-\s+\d{1,2}\s+\w+\s+\d{4}\s+-\s+.*$/i, '')
    .trim() || stem
}

export function parseVmixTimeline(xml: string): VmixTimeline {
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) throw new Error('The vMix MultiCorder XML exceeds the 10 MB safety limit.')
  if (/<!DOCTYPE[\s\S]*(?:SYSTEM|PUBLIC|\[)/i.test(xml)) throw new Error('External or inline XML declarations are not allowed.')
  if (!/<xmeml[\s>]/i.test(xml) || !/<\/xmeml>\s*$/i.test(xml)) {
    throw new Error('The vMix MultiCorder XML manifest is incomplete or invalid.')
  }
  assertSafeDepth(xml)

  let root: XmlNode
  try {
    root = parser.parse(xml) as XmlNode
  } catch {
    throw new Error('The vMix MultiCorder XML manifest is incomplete or invalid.')
  }
  const xmeml = asNode(root.xmeml)
  if (Array.isArray(xmeml?.sequence)) throw new Error('The vMix timeline contains more than one primary sequence.')
  const sequence = asNode(xmeml?.sequence)
  if (!sequence) throw new Error('The vMix timeline does not contain a primary sequence.')
  const media = asNode(sequence.media)
  const video = asNode(media?.video)
  const tracks = asArray(video?.track as XmlNode | XmlNode[] | undefined)
  if (!tracks.length) throw new Error('The vMix timeline contains no video tracks.')
  const rate = parseRate(sequence.rate, 'frame rate')
  const files = collectFileDefinitions(root)
  const clips: VmixTimelineClip[] = []

  tracks.forEach((trackValue, trackIndex) => {
    const track = asNode(trackValue)
    const clipitems = asArray(track?.clipitem as XmlNode | XmlNode[] | undefined)
    clipitems.forEach((clipValue, clipIndex) => {
      const clip = asNode(clipValue)
      if (!clip) throw new Error(`Video track ${trackIndex + 1} contains an invalid clipitem.`)
      const fileReference = asNode(clip.file)
      if (!fileReference) throw new Error(`Video track ${trackIndex + 1}, clip ${clipIndex + 1} has no file reference.`)
      const file = typeof fileReference.pathurl === 'string'
        ? fileReference
        : files.get(String(fileReference['@_id'] ?? ''))
      const pathUrl = typeof file?.pathurl === 'string' ? file.pathurl : null
      if (!file || !pathUrl) throw new Error(`Video track ${trackIndex + 1}, clip ${clipIndex + 1} has no resolvable source path.`)
      const startFrame = requiredInteger(clip.start, 'clip start')
      const endFrame = requiredInteger(clip.end, 'clip end')
      if (endFrame <= startFrame) throw new Error(`Video track ${trackIndex + 1}, clip ${clipIndex + 1} has a non-positive duration.`)
      const clipDurationFrames = optionalInteger(clip.duration, 'clip duration')
      const sourceInFrame = optionalInteger(clip.in, 'clip in')
      const sourceOutFrame = optionalInteger(clip.out, 'clip out')
      if ((sourceInFrame === null) !== (sourceOutFrame === null)) {
        throw new Error(`Video track ${trackIndex + 1}, clip ${clipIndex + 1} must declare both source in and out frames.`)
      }
      if (sourceInFrame !== null && sourceOutFrame !== null && sourceOutFrame <= sourceInFrame) {
        throw new Error(`Video track ${trackIndex + 1}, clip ${clipIndex + 1} has invalid source-frame bounds.`)
      }
      if (clipDurationFrames !== null && clipDurationFrames !== endFrame - startFrame) {
        throw new Error(`Video track ${trackIndex + 1}, clip ${clipIndex + 1} has inconsistent timeline duration metadata.`)
      }
      if (clipDurationFrames !== null && sourceInFrame !== null && sourceOutFrame !== null && clipDurationFrames !== sourceOutFrame - sourceInFrame) {
        throw new Error(`Video track ${trackIndex + 1}, clip ${clipIndex + 1} has inconsistent source duration metadata.`)
      }

      const fileMedia = asNode(file.media)
      const fileVideo = asNode(fileMedia?.video)
      const characteristics = asNode(fileVideo?.samplecharacteristics)
      const fileDurationFrames = optionalInteger(file.duration, 'file duration')
      const videoDurationFrames = optionalInteger(fileVideo?.duration, 'video duration')
      if (fileDurationFrames !== null && videoDurationFrames !== null && fileDurationFrames !== videoDurationFrames) {
        throw new Error(`Video track ${trackIndex + 1}, clip ${clipIndex + 1} has conflicting file-duration metadata.`)
      }
      const mediaDurationFrames = videoDurationFrames ?? fileDurationFrames
      if (mediaDurationFrames !== null && mediaDurationFrames <= 0) {
        throw new Error(`Video track ${trackIndex + 1}, clip ${clipIndex + 1} has an invalid media duration.`)
      }
      if (mediaDurationFrames !== null && sourceOutFrame !== null && sourceOutFrame > mediaDurationFrames) {
        throw new Error(`Video track ${trackIndex + 1}, clip ${clipIndex + 1} extends beyond its declared media duration.`)
      }
      const clipRate = optionalRate(clip, 'clip rate')
      const fileRate = optionalRate(file, 'file rate')
      if (clipRate && fileRate && !sameRate(clipRate, fileRate)) {
        throw new Error(`Video track ${trackIndex + 1}, clip ${clipIndex + 1} has conflicting source frame rates.`)
      }
      const mediaWidth = optionalInteger(characteristics?.width, 'video width')
      const mediaHeight = optionalInteger(characteristics?.height, 'video height')
      const audio = asNode(fileMedia?.audio)
      const mediaAudioChannels = optionalInteger(audio?.channelcount, 'audio channel count')
      if ((mediaWidth !== null && mediaWidth <= 0) || (mediaHeight !== null && mediaHeight <= 0) || (mediaAudioChannels !== null && mediaAudioChannels <= 0)) {
        throw new Error(`Video track ${trackIndex + 1}, clip ${clipIndex + 1} has invalid media characteristics.`)
      }
      const sourcePath = sourcePathFromVmixPathUrl(pathUrl)
      clips.push({
        trackIndex,
        clipIndex,
        clipId: typeof clip['@_id'] === 'string' ? clip['@_id'] : null,
        displayName: displayName(clip, file, sourcePath),
        pathUrl,
        sourcePath,
        startFrame,
        endFrame,
        sourceInFrame,
        sourceOutFrame,
        mediaDurationFrames,
        mediaRate: fileRate ?? clipRate,
        mediaWidth,
        mediaHeight,
        mediaAudioChannels
      })
    })
  })
  if (!clips.length) throw new Error('The vMix timeline contains no video clips.')
  return { rate, clips }
}

export function parseVmixManifestMediaNames(xml: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const clip of parseVmixTimeline(xml).clips) {
    const filename = filenameFromVmixPath(clip.sourcePath)
    const key = process.platform === 'win32' ? filename.toLowerCase() : filename
    if (!seen.has(key)) {
      seen.add(key)
      names.push(filename)
    }
  }
  return names
}

export function actualFramesPerSecond(rate: VmixTimelineRate): number {
  return rate.ntsc ? rate.timebase * 1000 / 1001 : rate.timebase
}

export function offsetSeconds(startFrame: number, zeroFrame: number, fps: number): number {
  if (![startFrame, zeroFrame, fps].every(Number.isFinite) || fps <= 0) throw new Error('Cannot calculate a sequence offset from invalid timing values.')
  const value = (startFrame - zeroFrame) / fps
  return Math.round(value * 1_000_000) / 1_000_000
}

export function vmixProjectNameFromManifest(path: string): string {
  const filename = basename(path)
  const stem = filename.slice(0, filename.length - extname(filename).length).trim()
  return stem || filename
}
