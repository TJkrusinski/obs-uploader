#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { ConfigStore, resolveDataDir } from './config.js'
import { RecordLedger } from './ledger.js'
import { ApplicationRuntime } from './runtime.js'
import { AdministrationServer } from './server.js'

const VERSION = '2.0.0'
type CliOptions = { dataDir?: string; host?: string; port?: number; open: boolean; help: boolean; version: boolean }
export function parseCli(args: string[]): CliOptions {
  const options: CliOptions = { open: false, help: false, version: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--data-dir') options.dataDir = args[++index]
    else if (argument === '--host') options.host = args[++index]
    else if (argument === '--port') options.port = Number(args[++index])
    else if (argument === '--open') options.open = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else if (argument === '--version' || argument === '-v') options.version = true
    else throw new Error(`Unknown option: ${argument}`)
  }
  if (args.includes('--data-dir') && !options.dataDir) throw new Error('--data-dir requires a path.')
  if (args.includes('--host') && !options.host) throw new Error('--host requires a value.')
  if (options.host && options.host !== '127.0.0.1') throw new Error('--host must be 127.0.0.1.')
  if (options.port != null && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw new Error('--port must be an integer from 1 to 65535.')
  return options
}

async function run(): Promise<void> {
  const options = parseCli(process.argv.slice(2))
  if (options.help) { console.log('movie-recorder-upload [--data-dir PATH] [--host 127.0.0.1] [--port PORT] [--open]'); return }
  if (options.version) { console.log(`movie-recorder-upload ${VERSION}`); return }
  if (process.platform !== 'darwin' && process.env.NODE_ENV === 'production') throw new Error('movie-recorder-upload supports macOS only.')
  const dataDir = resolveDataDir(options.dataDir); const config = await ConfigStore.open(dataDir); const opened = await RecordLedger.open(dataDir)
  const runtime = new ApplicationRuntime(config, opened.ledger, VERSION, randomBytes(32).toString('base64url'))
  const settings = config.get(); const host = options.host ?? settings.server.host; const port = options.port ?? settings.server.port
  const server = new AdministrationServer(runtime, host, port); const url = await server.start()
  console.log(JSON.stringify({ level: 'info', event: 'server_started', url, configPath: config.path, recordsPath: opened.ledger.path, recoveredBackup: opened.recovered }))
  if (options.open || settings.server.openBrowser) spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  await runtime.initialize()
  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return; stopping = true; console.log(JSON.stringify({ level: 'info', event: 'shutdown', signal }))
    await runtime.shutdown(); await server.close()
  }
  process.once('SIGINT', () => void shutdown('SIGINT')); process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

run().catch((error) => { console.error(JSON.stringify({ level: 'error', event: 'fatal', message: error instanceof Error ? error.message : String(error) })); process.exitCode = 1 })
