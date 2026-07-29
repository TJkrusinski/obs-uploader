import type { SessionFile } from '../shared/types.js'
import { vmixSequenceKey } from './descript-import.js'

export interface VmixProjectContents {
  media_files?: Record<string, { type?: string; duration?: number }>
  compositions?: Array<{ id: string; name: string }>
}

function expectedRemoteType(file: SessionFile): string | null {
  if (file.contentType.startsWith('video/')) return 'video'
  if (file.contentType.startsWith('audio/')) return 'audio'
  return null
}

export function inspectVmixProjectContents(
  files: SessionFile[],
  project: VmixProjectContents
): { uploadedFileIds: string[]; invalidFiles: Array<{ id: string; mediaKey: string; expectedType: string; actualType: string }>; complete: boolean } {
  const included = files.filter((file) => file.uploadStatus !== 'excluded')
  const remoteMedia = new Map(Object.entries(project.media_files ?? {}).map(([name, media]) => [name.toLowerCase(), media]))
  const uploadedFileIds: string[] = []
  const invalidFiles: Array<{ id: string; mediaKey: string; expectedType: string; actualType: string }> = []
  for (const file of included) {
    const remote = remoteMedia.get(file.descriptMediaKey.toLowerCase())
    if (!remote) continue
    const expectedType = expectedRemoteType(file)
    const actualType = remote.type ?? 'unknown'
    if (expectedType && actualType !== expectedType) {
      invalidFiles.push({ id: file.id, mediaKey: file.descriptMediaKey, expectedType, actualType })
    } else {
      uploadedFileIds.push(file.id)
    }
  }
  const hasAllFiles = uploadedFileIds.length === included.length
  const hasSequence = remoteMedia.get(vmixSequenceKey(included).toLowerCase())?.type === 'sequence'
  const hasComposition = (project.compositions ?? []).some((composition) => composition.name === 'Recording')
  return { uploadedFileIds, invalidFiles, complete: invalidFiles.length === 0 && hasAllFiles && hasSequence && hasComposition }
}
