import { constants } from 'node:fs'
import { access, chmod, copyFile, mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export class UnsupportedSchemaError extends Error {
  constructor(path: string, version: unknown) {
    super(`${basename(path)} uses unsupported schema version ${String(version)}.`)
    this.name = 'UnsupportedSchemaError'
  }
}

export type DocumentValidator<T> = (value: unknown, path: string) => T

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function parseDocument<T>(path: string, validate: DocumentValidator<T>): Promise<T> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  return validate(value, path)
}

export async function readRecoverableJson<T>(path: string, validate: DocumentValidator<T>): Promise<{ value: T; recovered: boolean }> {
  try {
    return { value: await parseDocument(path, validate), recovered: false }
  } catch (error) {
    if (error instanceof UnsupportedSchemaError) throw error
    try {
      return { value: await parseDocument(`${path}.bak`, validate), recovered: true }
    } catch (backupError) {
      if (backupError instanceof UnsupportedSchemaError) throw backupError
      throw new Error(`Neither ${basename(path)} nor its backup could be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export async function atomicWriteJson<T>(path: string, value: T, validate: DocumentValidator<T>, backupCurrent = true): Promise<void> {
  validate(value, path)
  await ensurePrivateDirectory(dirname(path))
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (backupCurrent) {
    try {
      await access(path, constants.F_OK)
      await copyFile(path, `${path}.bak`, constants.COPYFILE_FICLONE)
      await chmod(`${path}.bak`, 0o600)
    } catch { /* The first write has no previous generation to preserve. */ }
  }
  await rename(temporary, path)
  await chmod(path, 0o600)
  const directory = await open(dirname(path), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

export async function permissionWarning(path: string): Promise<string | null> {
  try {
    const metadata = await stat(path)
    return (metadata.mode & 0o077) === 0 ? null : `${basename(path)} permissions are broader than owner-only (${(metadata.mode & 0o777).toString(8)}).`
  } catch { return null }
}

export class SerializedJsonStore<T> {
  private queue: Promise<void> = Promise.resolve()
  constructor(readonly path: string, private readonly validate: DocumentValidator<T>, private value: T) {}
  get(): T { return structuredClone(this.value) }
  async replace(next: T): Promise<void> {
    const checked = this.validate(structuredClone(next), this.path)
    this.queue = this.queue.then(async () => {
      await atomicWriteJson(this.path, checked, this.validate)
      this.value = structuredClone(checked)
    })
    return this.queue
  }
  async update(updater: (current: T) => T | void): Promise<T> {
    let result!: T
    this.queue = this.queue.then(async () => {
      const draft = structuredClone(this.value)
      result = this.validate(updater(draft) ?? draft, this.path)
      await atomicWriteJson(this.path, result, this.validate)
      this.value = structuredClone(result)
    })
    await this.queue
    return structuredClone(result)
  }
  async flush(): Promise<void> { await this.queue }
}
