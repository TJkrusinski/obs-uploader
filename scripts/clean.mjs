import { rm } from 'node:fs/promises'

for (const path of ['build/movie-recorder-upload.cjs', 'build/sea-config.json', 'build/sea-prep.blob', 'dist', 'dist-electron', 'dist-server', 'release/movie-recorder-upload']) {
  await rm(path, { recursive: true, force: true })
}
