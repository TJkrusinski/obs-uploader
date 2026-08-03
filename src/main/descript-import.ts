import type { CaptureSession, SessionFile } from '../shared/types.js'
import { actualFramesPerSecond, offsetSeconds } from './vmix-manifest.js'

type DirectUploadMedia = {
  content_type: string
  file_size: number
}

type MultitrackSequence = {
  tracks: Array<{ media: string; offset: number }>
}

export interface DescriptImportBody {
  project_name: string
  folder_name: string
  team_access: 'edit'
  add_media: Record<string, DirectUploadMedia | MultitrackSequence>
  add_compositions: Array<{ name: string; width: number; height: number; clips: Array<{ media: string }> }>
}

function availableReferenceId(files: SessionFile[], requested: string): string {
  const used = new Set(files.map((file) => file.descriptMediaKey.toLowerCase()))
  let candidate = requested
  let suffix = 2
  while (used.has(candidate.toLowerCase())) candidate = `${requested} (${suffix++})`
  return candidate
}

export function vmixSequenceKey(files: SessionFile[]): string {
  return availableReferenceId(files, 'MultiCorder Sequence')
}

function nullableNumber(value: number | null): number {
  return value == null ? Number.MAX_SAFE_INTEGER : value
}

export function compareSequenceFiles(left: SessionFile, right: SessionFile): number {
  const primaryDifference = Number(right.sourceRole === 'primary') - Number(left.sourceRole === 'primary')
  if (primaryDifference !== 0) return primaryDifference
  return (
    nullableNumber(left.manifestTrackIndex) - nullableNumber(right.manifestTrackIndex) ||
    nullableNumber(left.timelineStartFrame) - nullableNumber(right.timelineStartFrame) ||
    nullableNumber(left.manifestClipIndex) - nullableNumber(right.manifestClipIndex) ||
    left.segmentIndex - right.segmentIndex ||
    left.descriptMediaKey.localeCompare(right.descriptMediaKey)
  )
}

export function buildVmixSequenceTracks(session: CaptureSession, files: SessionFile[]): Array<{ media: string; offset: number }> {
  if (!files.length) throw new Error('The vMix session has no included media.')
  if (files.length > 14) {
    throw new Error(`This session has ${files.length} physical clips, exceeding Descript's 14-track sequence limit.`)
  }
  if (session.syncMode === 'assumed_zero') return files.map((file) => ({ media: file.descriptMediaKey, offset: 0 }))
  if (session.syncMode !== 'manifest') throw new Error('This session has no trustworthy synchronization information.')
  if (session.timelineTimebase == null || session.timelineNtsc == null || files.some((file) => file.timelineStartFrame == null)) {
    throw new Error('The vMix manifest timing metadata is incomplete.')
  }
  const fps = actualFramesPerSecond({ timebase: session.timelineTimebase, ntsc: session.timelineNtsc })
  const zeroFrame = Math.min(...files.map((file) => file.timelineStartFrame!))
  return files.map((file) => {
    const offset = offsetSeconds(file.timelineStartFrame!, zeroFrame, fps)
    if (!Number.isFinite(offset) || offset < 0) throw new Error(`The vMix sequence offset for ${file.descriptMediaKey} is invalid.`)
    return { media: file.descriptMediaKey, offset }
  })
}

export function buildDescriptImportBody(session: CaptureSession): DescriptImportBody {
  const files = session.files.filter((file) => file.uploadStatus !== 'excluded').sort(compareSequenceFiles)
  if (!files.length) throw new Error('The session has no included media.')
  const mediaKeys = new Set<string>()
  for (const file of files) {
    const key = file.descriptMediaKey.trim().toLowerCase()
    if (!key || mediaKeys.has(key)) throw new Error(`The session contains a duplicate or empty Descript media key: ${file.descriptMediaKey}`)
    if (!Number.isSafeInteger(file.fileSize) || file.fileSize <= 0) throw new Error(`${file.descriptMediaKey} has an invalid file size.`)
    mediaKeys.add(key)
  }
  const addMedia: DescriptImportBody['add_media'] = Object.fromEntries(
    files.map((file) => [file.descriptMediaKey, { content_type: file.contentType, file_size: file.fileSize }])
  )
  let compositionClips: Array<{ media: string }>
  if (session.recorderType === 'vmix') {
    const primaryFiles = files.filter((file) => file.sourceRole === 'primary')
    if (!primaryFiles.length || new Set(primaryFiles.map((file) => file.locationId)).size !== 1) throw new Error('The vMix session must have exactly one primary source.')
    const sequenceKey = vmixSequenceKey(files)
    addMedia[sequenceKey] = { tracks: buildVmixSequenceTracks(session, files) }
    compositionClips = [{ media: sequenceKey }]
  } else {
    compositionClips = files.filter((file) => file.sourceRole === 'primary').map((file) => ({ media: file.descriptMediaKey }))
    if (!compositionClips.length) throw new Error('This session has no primary recording.')
  }
  return {
    project_name: session.descriptProjectName,
    folder_name: session.descriptFolderPath,
    team_access: 'edit',
    add_media: addMedia,
    add_compositions: [{ name: 'Recording', width: 1920, height: 1080, clips: compositionClips }]
  }
}
