import { promises as fs } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class VmixMediaNotFoundError extends Error {}
export class VmixMediaAmbiguousError extends Error {}

function inside(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate))
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

async function existingAllowedFile(path: string, allowedRoot: string): Promise<string | null> {
  try {
    const realRoot = await fs.realpath(allowedRoot)
    const realPath = await fs.realpath(path)
    const stats = await fs.stat(realPath)
    return stats.isFile() && inside(realRoot, realPath) ? realPath : null
  } catch {
    return null
  }
}

async function findByBasename(root: string, filename: string, matches: Set<string>, depth = 0): Promise<void> {
  if (matches.size > 1 || depth > 8) return
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === '.obs-upload-normalized') continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) await findByBasename(path, filename, matches, depth + 1)
    else if (entry.isFile() && (process.platform === 'win32' ? entry.name.toLowerCase() === filename.toLowerCase() : entry.name === filename)) {
      matches.add(await fs.realpath(path))
    }
    if (matches.size > 1) return
  }
}

export async function resolveVmixSourcePath(sourcePath: string, xmlDirectory: string, allowedRoots: string[]): Promise<string> {
  if (!allowedRoots.length) throw new Error('At least one vMix recording root is required.')
  const filename = basename(sourcePath.replace(/\\/g, '/'))
  if (!filename) throw new Error(`The vMix timeline contains an invalid source path: ${sourcePath}`)
  const candidates = [sourcePath, join(xmlDirectory, filename)]
  for (const candidate of candidates) {
    for (const allowedRoot of allowedRoots) {
      const resolved = await existingAllowedFile(candidate, allowedRoot)
      if (resolved) return resolved
    }
  }
  const matches = new Set<string>()
  for (const allowedRoot of allowedRoots) {
    await findByBasename(allowedRoot, filename, matches)
    if (matches.size > 1) break
  }
  if (matches.size === 1) return [...matches][0]
  if (matches.size > 1) throw new VmixMediaAmbiguousError(`Referenced media is ambiguous inside the configured recording roots: ${filename}`)
  throw new VmixMediaNotFoundError(`Referenced media was not found inside the configured recording roots: ${filename}`)
}
