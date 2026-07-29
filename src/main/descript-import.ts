import type { CaptureSession, SessionFile } from '../shared/types.js'

type DirectUploadMedia = {
  content_type: string
  file_size: number
}

type MultitrackSequence = {
  tracks: Array<{ media: string; offset: number }>
}

export interface DescriptImportBody {
  project_id?: string
  project_name?: string
  folder_name?: string
  team_access?: 'edit'
  add_media: Record<string, DirectUploadMedia | MultitrackSequence>
  add_compositions: Array<{ name: string; clips: Array<{ media: string }> }>
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

export function buildDescriptImportBody(
  session: CaptureSession,
  options: { projectId?: string; directUploadFileIds?: Set<string> } = {}
): DescriptImportBody {
  const files = session.files.filter((file) => file.uploadStatus !== 'excluded')
  const directUploadFiles = options.directUploadFileIds
    ? files.filter((file) => options.directUploadFileIds!.has(file.id))
    : files
  const addMedia: DescriptImportBody['add_media'] = Object.fromEntries(
    directUploadFiles.map((file) => [file.descriptMediaKey, { content_type: file.contentType, file_size: file.fileSize }])
  )
  let compositionClips: Array<{ media: string }>
  if (session.recorderType === 'vmix') {
    const sequenceKey = vmixSequenceKey(files)
    addMedia[sequenceKey] = {
      tracks: files.map((file) => ({ media: file.descriptMediaKey, offset: 0 }))
    }
    compositionClips = [{ media: sequenceKey }]
  } else {
    compositionClips = files
      .filter((file) => file.sourceRole === 'primary')
      .map((file) => ({ media: file.descriptMediaKey }))
  }
  return {
    ...(options.projectId
      ? { project_id: options.projectId }
      : {
          project_name: session.descriptProjectName,
          folder_name: session.descriptFolderPath,
          team_access: 'edit' as const
        }),
    add_media: addMedia,
    add_compositions: [{ name: 'Recording', clips: compositionClips }]
  }
}
