import { chmod, copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'

if (process.platform !== 'darwin') throw new Error('The SEA release build supports macOS only.')
if (process.config.variables.single_executable_application !== true) {
  throw new Error('This Node.js binary has SEA disabled. Use an official Node.js 24 arm64 build instead of Homebrew\'s shared-libnode build.')
}
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
// The supported v1 artifact is Apple Silicon. Official nvm downloads are already
// thin arm64 binaries, while the macOS installer can provide a universal binary.
// Universal binaries must be thinned so postject sees exactly one SEA sentinel.
const architecture = spawnSync('lipo', ['-archs', process.execPath], { encoding: 'utf8' })
if (architecture.status !== 0) throw new Error('Unable to inspect the Node.js executable architecture with lipo.')
const architectures = architecture.stdout.trim().split(/\s+/).filter(Boolean)
if (!architectures.includes('arm64')) throw new Error(`The Node.js executable does not contain arm64 code (${architectures.join(', ') || 'unknown architecture'}).`)
if (architectures.length > 1) run('lipo', ['-thin', 'arm64', process.execPath, '-output', executable])
else await copyFile(process.execPath, executable)
await chmod(executable, 0o755)
run('codesign', ['--remove-signature', executable])
run(resolve(root, 'node_modules/.bin/postject'), [executable, 'NODE_SEA_BLOB', resolve(root, 'build/sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--macho-segment-name', 'NODE_SEA'])
run('codesign', ['--sign', '-', executable])
console.log(`Built ${executable}`)
