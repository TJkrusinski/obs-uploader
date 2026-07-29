import { basename, extname } from 'node:path'

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function manifestFilename(pathUrl: string): string | null {
  let value = decodeXmlText(pathUrl.trim())
  try { value = decodeURIComponent(value) } catch { /* Keep malformed percent escapes literal. */ }
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  const filename = normalized.slice(normalized.lastIndexOf('/') + 1).trim()
  return filename || null
}

export function parseVmixManifestMediaNames(xml: string): string[] {
  if (!/<xmeml[\s>]/i.test(xml) || !/<\/xmeml>\s*$/i.test(xml)) {
    throw new Error('The vMix MultiCorder XML manifest is incomplete or invalid.')
  }
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of xml.matchAll(/<pathurl>([\s\S]*?)<\/pathurl>/gi)) {
    const filename = manifestFilename(match[1])
    if (!filename) continue
    const key = process.platform === 'win32' ? filename.toLowerCase() : filename
    if (seen.has(key)) continue
    seen.add(key)
    names.push(filename)
  }
  if (!names.length) throw new Error('The vMix MultiCorder XML manifest does not reference any media files.')
  return names
}

export function vmixProjectNameFromManifest(path: string): string {
  const filename = basename(path)
  const stem = filename.slice(0, filename.length - extname(filename).length).trim()
  return stem || filename
}
