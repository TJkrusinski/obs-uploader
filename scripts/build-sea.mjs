import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'

if (process.platform !== 'darwin') throw new Error('The SEA release build supports macOS only.')
const root = process.cwd(); const dist = resolve(root, 'dist'); const assets = {}
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collect(path)
    else assets[relative(dist, path)] = path
  }
}
await collect(dist)
await mkdir(resolve(root, 'release'), { recursive: true })
await writeFile(resolve(root, 'build/sea-config.json'), JSON.stringify({
  main: resolve(root, 'build/movie-recorder-upload.cjs'), output: resolve(root, 'build/sea-prep.blob'), disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets
}, null, 2))
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}.`)
}
run(process.execPath, ['--experimental-sea-config', resolve(root, 'build/sea-config.json')])
const executable = resolve(root, 'release/movie-recorder-upload')
// The supported v1 artifact is Apple Silicon. Thinning a universal Node binary also
// leaves one SEA sentinel for postject to patch deterministically.
run('lipo', ['-thin', 'arm64', process.execPath, '-output', executable]); await chmod(executable, 0o755)
run('codesign', ['--remove-signature', executable])
run(resolve(root, 'node_modules/.bin/postject'), [executable, 'NODE_SEA_BLOB', resolve(root, 'build/sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--macho-segment-name', 'NODE_SEA'])
run('codesign', ['--sign', '-', executable])
console.log(`Built ${executable}`)
