import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { resolveVmixSourcePath, VmixMediaNotFoundError } from '../dist-electron/main/vmix-file-resolution.js'

let directory
before(async () => { directory = await mkdtemp(join(tmpdir(), 'obs-upload-vmix-resolution-')) })
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

test('prefers an exact canonical local path inside an allowed root', async () => {
  const path = join(directory, 'Camera 1.mp4')
  await writeFile(path, 'video')
  assert.equal(await resolveVmixSourcePath(path, directory, [directory]), await realpath(path))
})

test('falls back to one basename match across mapped recording roots', async () => {
  const root = join(directory, 'mapped')
  await mkdir(join(root, 'nested'), { recursive: true })
  const path = join(root, 'nested', 'Camera 2.mp4')
  await writeFile(path, 'video')
  assert.equal(await resolveVmixSourcePath('D:/Recordings/Camera 2.mp4', directory, [root]), await realpath(path))
})

test('rejects duplicate basenames but deduplicates overlapping roots', async () => {
  const root = join(directory, 'duplicates')
  await mkdir(join(root, 'one'), { recursive: true })
  await mkdir(join(root, 'two'), { recursive: true })
  await writeFile(join(root, 'one', 'Camera.mp4'), 'one')
  await writeFile(join(root, 'two', 'Camera.mp4'), 'two')
  await assert.rejects(resolveVmixSourcePath('Z:/Camera.mp4', directory, [root]), /ambiguous/)

  const uniqueRoot = join(directory, 'unique')
  await mkdir(join(uniqueRoot, 'nested'), { recursive: true })
  const unique = join(uniqueRoot, 'nested', 'Only.mp4')
  await writeFile(unique, 'only')
  assert.equal(await resolveVmixSourcePath('Z:/Only.mp4', directory, [uniqueRoot, join(uniqueRoot, 'nested')]), await realpath(unique))
})

test('identifies not-yet-created media as a retryable resolution condition', async () => {
  await assert.rejects(
    resolveVmixSourcePath('Z:/Still Writing.mp4', directory, [directory]),
    (error) => error instanceof VmixMediaNotFoundError && /was not found/.test(error.message)
  )
})
