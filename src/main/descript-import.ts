import type { CaptureSession } from '../shared/types.js'

type DirectUploadMedia = { content_type: string; file_size: number }

export interface DescriptImportBody {
  project_name: string
  folder_name: string
  team_access: 'edit'
  add_media: Record<string, DirectUploadMedia>
  add_compositions: Array<{
    name: 'Recording'
    width: 1920
    height: 1080
    clips: Array<{ media: string }>
  }>
}

export function buildDescriptImportBody(session: CaptureSession): DescriptImportBody {
  if (session.recorderType !== 'obs') throw new Error('This recording source is no longer supported.')
  const files = session.files.filter((file) => file.uploadStatus !== 'excluded')
  if (!files.length) throw new Error('The session has no included media.')

  const mediaKeys = new Set<string>()
  for (const file of files) {
    const key = file.descriptMediaKey.trim().toLowerCase()
    if (!key || mediaKeys.has(key)) throw new Error(`The session contains a duplicate or empty Descript media key: ${file.descriptMediaKey}`)
    if (!Number.isSafeInteger(file.fileSize) || file.fileSize <= 0) throw new Error(`${file.descriptMediaKey} has an invalid file size.`)
    mediaKeys.add(key)
  }

  const compositionClips = files
    .filter((file) => file.sourceRole === 'primary')
    .map((file) => ({ media: file.descriptMediaKey }))
  if (!compositionClips.length) throw new Error('This session has no primary recording.')

  return {
    project_name: session.descriptProjectName,
    folder_name: session.descriptFolderPath,
    team_access: 'edit',
    add_media: Object.fromEntries(
      files.map((file) => [file.descriptMediaKey, { content_type: file.contentType, file_size: file.fileSize }])
    ),
    add_compositions: [{ name: 'Recording', width: 1920, height: 1080, clips: compositionClips }]
  }
}
