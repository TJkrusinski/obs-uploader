/* Ensures Electron's macOS/Windows/Linux binary was fully extracted after npm install. */
const fs = require('node:fs')
const path = require('node:path')
const { downloadArtifact } = require('@electron/get')
const extract = require('extract-zip')

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron')
const electron = require(path.join(electronDir, 'package.json'))
const platform = process.platform
const arch = process.arch
const platformPath = platform === 'darwin'
  ? 'Electron.app/Contents/MacOS/Electron'
  : platform === 'win32' ? 'electron.exe' : 'electron'
const executable = path.join(electronDir, 'dist', platformPath)

async function ensureElectron() {
  if (fs.existsSync(executable)) return
  const archive = await downloadArtifact({
    version: electron.version,
    artifactName: 'electron',
    platform,
    arch,
    checksums: require(path.join(electronDir, 'checksums.json'))
  })
  await extract(archive, { dir: path.join(electronDir, 'dist') })
  fs.writeFileSync(path.join(electronDir, 'path.txt'), platformPath)
}

ensureElectron().catch((error) => {
  console.error('Unable to finish Electron installation:', error)
  process.exit(1)
})
