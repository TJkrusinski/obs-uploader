import type { SessionFile } from '../shared/types.js'
import { vmixSequenceKey } from './descript-import.js'

export interface VmixProjectContents {
  media_files?: Record<string, { type?: string; duration?: number }>
  compositions?: Array<{ id: string; name: string }>
}

export function inspectVmixProjectContents(
  files: SessionFile[],
  project: VmixProjectContents
): { uploadedFileIds: string[]; complete: boolean } {
  const included = files.filter((file) => file.uploadStatus !== 'excluded')
  const remoteMedia = new Set(Object.keys(project.media_files ?? {}).map((name) => name.toLowerCase()))
  const uploadedFileIds = included
    .filter((file) => remoteMedia.has(file.descriptMediaKey.toLowerCase()))
    .map((file) => file.id)
  const hasAllFiles = uploadedFileIds.length === included.length
  const hasSequence = remoteMedia.has(vmixSequenceKey(included).toLowerCase())
  const hasComposition = (project.compositions ?? []).some((composition) => composition.name === 'Recording')
  return { uploadedFileIds, complete: hasAllFiles && hasSequence && hasComposition }
}
