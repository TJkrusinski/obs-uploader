import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { getAsset, isSea } from 'node:sea'
import type { AddressInfo } from 'node:net'
import type { ApiErrorBody, EditableConfig } from '../shared/types.js'
import { ApplicationRuntime } from './runtime.js'

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
class ApiError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } }
const responseJson = (response: ServerResponse, status: number, body: unknown): void => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)) }

async function body(request: IncomingMessage): Promise<unknown> {
  let data = ''
  for await (const chunk of request) { data += chunk; if (data.length > 128_000) throw new ApiError(413, 'body_too_large', 'Request body is too large.') }
  try { return data ? JSON.parse(data) : {} } catch { throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON.') }
}

function editable(value: unknown): EditableConfig {
  if (!value || typeof value !== 'object') throw new ApiError(400, 'invalid_input', 'Configuration input must be an object.')
  return value as EditableConfig
}

export class AdministrationServer {
  private clients = new Set<ServerResponse>()
  private origin = ''
  private unsubscribe: (() => void) | null = null
  readonly server = createServer((request, response) => void this.handle(request, response))
  constructor(private readonly runtime: ApplicationRuntime, private readonly host: string, private readonly port: number) {}
  async start(): Promise<string> {
    if (this.host !== '127.0.0.1') throw new Error('Only 127.0.0.1 binding is allowed.')
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, this.host, () => { this.server.off('error', reject); resolve() }) })
    const actual = (this.server.address() as AddressInfo).port; this.origin = `http://${this.host}:${actual}`
    this.unsubscribe = this.runtime.subscribe(() => this.broadcast())
    return this.origin
  }
  async close(): Promise<void> {
    this.unsubscribe?.(); this.clients.forEach((client) => client.end()); this.clients.clear()
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()))
  }
  private security(response: ServerResponse): void {
    response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cache-Control', 'no-store')
  }
  private validateRequest(request: IncomingMessage): void {
    const host = request.headers.host
    if (!host || host !== new URL(this.origin).host) throw new ApiError(400, 'invalid_host', 'Host header is not allowed.')
    if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) {
      if (request.headers.origin !== this.origin) throw new ApiError(403, 'invalid_origin', 'Cross-origin mutation rejected.')
      if (request.headers['x-bootstrap-token'] !== this.runtime.bootstrapToken) throw new ApiError(403, 'invalid_token', 'Bootstrap token is missing or invalid.')
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new ApiError(415, 'invalid_content_type', 'Mutations require application/json.')
    }
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.security(response)
    try {
      this.validateRequest(request); const url = new URL(request.url ?? '/', this.origin); const method = request.method ?? 'GET'
      if (method === 'GET' && url.pathname === '/api/snapshot') return responseJson(response, 200, this.runtime.snapshot())
      if (method === 'GET' && url.pathname === '/api/health') return responseJson(response, 200, this.runtime.snapshot().health)
      if (method === 'GET' && url.pathname === '/api/config') return responseJson(response, 200, this.runtime.snapshot().config)
      if (method === 'GET' && url.pathname === '/api/records') return responseJson(response, 200, this.runtime.ledger.records())
      if (method === 'GET' && url.pathname.startsWith('/api/records/')) {
        const record = this.runtime.ledger.find(decodeURIComponent(url.pathname.slice('/api/records/'.length)))
        if (!record) throw new ApiError(404, 'record_not_found', 'Recording not found.')
        return responseJson(response, 200, record)
      }
      if (method === 'GET' && url.pathname === '/api/events') return this.events(request, response)
      if (method === 'POST' && url.pathname === '/api/config') {
        try { await this.runtime.updateConfig(editable(await body(request))) }
        catch (error) { throw new ApiError(400, 'invalid_configuration', error instanceof Error ? error.message : String(error)) }
        return responseJson(response, 200, this.runtime.snapshot().config)
      }
      if (method === 'POST' && url.pathname === '/api/mode') {
        const input = await body(request) as { mode?: unknown }; if (input.mode !== 'standby' && input.mode !== 'watching') throw new ApiError(400, 'invalid_mode', 'Mode must be standby or watching.')
        try { await this.runtime.enterMode(input.mode) } catch (error) { throw new ApiError(422, 'mode_transition_failed', error instanceof Error ? error.message : String(error)) }
        return responseJson(response, 200, { mode: input.mode })
      }
      if (method === 'POST' && url.pathname === '/api/test/movierecorder') return responseJson(response, 200, await this.runtime.testMovieRecorder())
      if (method === 'POST' && url.pathname === '/api/test/descript') return responseJson(response, 200, await this.runtime.testDescript())
      const action = url.pathname.match(/^\/api\/records\/([^/]+)\/(retry|skip|restore)$/)
      if (method === 'POST' && action) {
        const id = decodeURIComponent(action[1]); await body(request)
        if (action[2] === 'retry') await this.runtime.coordinator.retry(id)
        else if (action[2] === 'skip') await this.runtime.skip(id)
        else if (action[2] === 'restore') await this.runtime.restore(id)
        return responseJson(response, 200, this.runtime.ledger.find(id))
      }
      if (url.pathname.startsWith('/api/')) throw new ApiError(404, 'route_not_found', 'API route not found.')
      await this.static(url.pathname, response)
    } catch (error) {
      const api = error instanceof ApiError ? error : new ApiError(500, 'internal_error', error instanceof Error ? error.message : String(error))
      const result: ApiErrorBody = { error: { code: api.code, message: api.message } }; responseJson(response, api.status, result)
    }
  }
  private events(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'Cache-Control': 'no-cache, no-transform' })
    response.write(`event: snapshot\ndata: ${JSON.stringify(this.runtime.snapshot())}\n\n`); this.clients.add(response)
    request.once('close', () => this.clients.delete(response))
  }
  private broadcast(): void { const event = `event: snapshot\ndata: ${JSON.stringify(this.runtime.snapshot())}\n\n`; this.clients.forEach((client) => client.write(event)) }
  private async static(pathname: string, response: ServerResponse): Promise<void> {
    const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\//, '')
    const key = safe && extname(safe) ? safe : 'index.html'
    let data: Uint8Array
    try { data = isSea() ? new Uint8Array(getAsset(key)) : await readFile(join(process.cwd(), 'dist', key)) }
    catch { if (key !== 'index.html') throw new ApiError(404, 'asset_not_found', 'Asset not found.'); throw new ApiError(503, 'ui_unavailable', 'Administration UI assets are unavailable.') }
    response.writeHead(200, { 'Content-Type': MIME[extname(key)] ?? 'application/octet-stream' }); response.end(data)
  }
}
