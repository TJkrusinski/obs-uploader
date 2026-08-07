import type { RecordingRecord } from '../shared/types.js'

type UploadMedia = { content_type: string; file_size: number }
type Multitrack = { tracks: Array<{ media: string; offset: number }> }
export interface DescriptImportBody {
  project_name: string
  folder_name: string
  team_access: 'edit'
  add_media: Record<string, UploadMedia | Multitrack>
  add_compositions: Array<{ name: 'Recording'; width: 1920; height: 1080; clips: Array<{ media: string }> }>
}

export function buildDescriptImportBody(record: RecordingRecord): DescriptImportBody {
  const files = [...record.files].sort((left, right) => left.role === right.role
    ? left.timelineOffsetSeconds - right.timelineOffsetSeconds || left.segmentIndex - right.segmentIndex
    : left.role === 'primary' ? -1 : 1)
  if (!files.length) throw new Error('The session has no media.')
  if (!files.some((file) => file.role === 'primary')) throw new Error('The session has no primary source.')
  if (files.some((file) => file.fingerprint.size <= 0)) throw new Error('The session contains an invalid file size.')
  if (files.some((file) => file.stability !== 'stable' || !file.validation?.ok)) throw new Error('Every file must be stable and valid before import.')
  const keys = new Set<string>()
  const addMedia: Record<string, UploadMedia | Multitrack> = {}
  for (const file of files) {
    if (!file.mediaKey || keys.has(file.mediaKey)) throw new Error(`The session contains a duplicate or empty Descript media key: ${file.mediaKey}`)
    keys.add(file.mediaKey); addMedia[file.mediaKey] = { content_type: file.contentType, file_size: file.fingerprint.size }
  }
  const logicalKey = 'Softron Session'
  addMedia[logicalKey] = { tracks: files.map((file) => ({ media: file.mediaKey, offset: file.timelineOffsetSeconds })) }
  return {
    project_name: record.descriptProjectName, folder_name: record.descriptFolder, team_access: 'edit', add_media: addMedia,
    add_compositions: [{ name: 'Recording', width: 1920, height: 1080, clips: [{ media: logicalKey }] }]
  }
}
