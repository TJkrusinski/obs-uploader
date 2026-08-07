import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { stableFingerprint, validateMediaFile } from '../dist-server/main/media.js'

test('requires stable non-empty files and persists structural ffprobe results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'movie-recorder-media-'))
  const media = join(directory, 'Program.mov'); const probe = join(directory, 'ffprobe')
  await writeFile(media, 'media bytes')
  await writeFile(probe, `#!/bin/sh
if [ "$1" = "-version" ]; then echo "ffprobe version test-1"; exit 0; fi
echo '{"streams":[{"index":0,"codec_type":"video","codec_name":"h264"}],"format":{"duration":"12.5","format_name":"mov"}}'
`)
  await chmod(probe, 0o755)
  try {
    const fingerprint = await stableFingerprint(media, { probes: 2, delayMs: 1 })
    assert.match(fingerprint.sha256, /^[a-f0-9]{64}$/)
    const validation = await validateMediaFile(media, probe, fingerprint)
    assert.equal(validation.ok, true); assert.equal(validation.durationSeconds, 12.5); assert.equal(validation.ffprobeVersion, 'ffprobe version test-1')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
