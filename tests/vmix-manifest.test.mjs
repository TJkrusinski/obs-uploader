import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parseVmixManifestMediaNames } from '../dist-electron/main/vmix-manifest.js'

test('extracts the unique media files from the example MultiCorder manifest', async () => {
  const xml = await readFile(new URL('../multicorder_example/MultiCorder - Timeline - 28 July 2026 - 11-53-49 AM.xml', import.meta.url), 'utf8')
  assert.deepEqual(parseVmixManifestMediaNames(xml), [
    'MultiCorder2 - DeckLink Quad (2) 2 - 28 July 2026 - 11-53-49 AM.mp4',
    'MultiCorder4 - DeckLink Quad (4) 4 - 28 July 2026 - 11-53-49 AM.mp4',
    'MultiCorder8 - DeckLink Quad (8) 8 - 28 July 2026 - 11-53-49 AM.mp4',
    'MultiCorder9 - Output 1 - 28 July 2026 - 11-53-49 AM.mp4'
  ])
})

test('rejects a manifest before its closing tag has been written', () => {
  assert.throws(
    () => parseVmixManifestMediaNames('<xmeml><pathurl>file://localhost/C:/recording.mp4</pathurl>'),
    /incomplete or invalid/
  )
})

test('decodes XML entities and URL escapes in media paths', () => {
  const xml = '<xmeml><pathurl>file://localhost/C:/A%20%26%20B.mp4</pathurl><pathurl>file://localhost/C:/A%20%26%20B.mp4</pathurl></xmeml>'
  assert.deepEqual(parseVmixManifestMediaNames(xml), ['A & B.mp4'])
})
