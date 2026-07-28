import type { CaptureSession, SessionFile } from '../shared/types.js'

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
  add_compositions: Array<{ name: string; clips: Array<{ media: string }> }>
}

function availableReferenceId(files: SessionFile[], requested: string): string {
  const used = new Set(files.map((file) => file.descriptMediaKey.toLowerCase()))
  let candidate = requested
  let suffix = 2
  while (used.has(candidate.toLowerCase())) candidate = `${requested} (${suffix++})`
  return candidate
}

export function buildDescriptImportBody(session: CaptureSession): DescriptImportBody {
  const files = session.files.filter((file) => file.uploadStatus !== 'excluded')
  const addMedia: DescriptImportBody['add_media'] = Object.fromEntries(
    files.map((file) => [file.descriptMediaKey, { content_type: file.contentType, file_size: file.fileSize }])
  )
  let compositionClips: Array<{ media: string }>
  if (session.recorderType === 'vmix') {
    const sequenceKey = availableReferenceId(files, 'MultiCorder Sequence')
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
    project_name: session.descriptProjectName,
    folder_name: session.descriptFolderPath,
    team_access: 'edit',
    add_media: addMedia,
    add_compositions: [{ name: 'Recording', clips: compositionClips }]
  }
}
