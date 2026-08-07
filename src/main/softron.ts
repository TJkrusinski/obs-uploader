import { access } from 'node:fs/promises'
import type { AppConfig, ConnectionHealth, DestinationSnapshot, SoftronDestination, SoftronSource } from '../shared/types.js'

type RawSource = {
  unique_id?: unknown; display_name?: unknown; device_name?: unknown; recording_name?: unknown
  recording_start_date?: unknown; recording_end_date?: unknown; is_recording?: unknown; is_paused?: unknown; is_enabled?: unknown
  enabled_destinations?: unknown; selected_destinations?: unknown
}
type RawDestination = { unique_id?: unknown; name?: unknown; path?: unknown }
const SOCKET_PROTOCOL = 'v1.1.main_update.movierecorder.softronmedia.com'
const text = (value: unknown): string => typeof value === 'string' ? value : ''

export function sourceFromApi(value: RawSource): SoftronSource | null {
  const uniqueId = text(value.unique_id)
  if (!uniqueId) return null
  const destinations = Array.isArray(value.enabled_destinations) ? value.enabled_destinations : Array.isArray(value.selected_destinations) ? value.selected_destinations : []
  return {
    uniqueId, displayName: text(value.display_name) || text(value.device_name) || uniqueId, deviceName: text(value.device_name),
    recordingName: text(value.recording_name), recordingStartDate: text(value.recording_start_date), recordingEndDate: text(value.recording_end_date),
    isRecording: value.is_recording === true, isPaused: value.is_paused === true, isEnabled: value.is_enabled !== false,
    enabledDestinationIds: destinations.map((destination) => typeof destination === 'string' ? destination : destination && typeof destination === 'object' ? text((destination as Record<string, unknown>).destination_unique_id) : '').filter(Boolean),
    recordingPaths: destinations.map((destination) => destination && typeof destination === 'object' ? text((destination as Record<string, unknown>).destination_recording_path) : '').filter(Boolean)
  }
}

export function destinationFromApi(value: RawDestination): SoftronDestination | null {
  const uniqueId = text(value.unique_id)
  return uniqueId ? { uniqueId, name: text(value.name) || uniqueId, path: text(value.path) || null } : null
}

export async function resolveDestinations(destinations: SoftronDestination[], config: AppConfig): Promise<DestinationSnapshot[]> {
  return Promise.all(destinations.map(async (destination) => {
    const candidates = [destination.path, config.softron.destinationMappings[destination.uniqueId]].filter((path): path is string => Boolean(path))
    let localPath: string | null = null
    for (const path of candidates) {
      try { await access(path); localPath = path; break } catch { /* Try the explicit mounted path next. */ }
    }
    return { ...destination, localPath, readable: Boolean(localPath) }
  }))
}

export interface MovieRecorderSnapshot { identity: string; sources: SoftronSource[]; destinations: SoftronDestination[]; at: string }

export class MovieRecorderClient {
  private running = false
  private socket: WebSocket | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private polling = false
  private health: ConnectionHealth = 'disconnected'
  private last: MovieRecorderSnapshot | null = null
  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly onSnapshot: (snapshot: MovieRecorderSnapshot) => Promise<void>,
    private readonly onHealth: (health: ConnectionHealth) => void,
    private readonly onConnectionLost: () => Promise<void>
  ) {}
  getHealth(): ConnectionHealth { return this.health }
  getSnapshot(): MovieRecorderSnapshot | null { return this.last ? structuredClone(this.last) : null }
  async test(): Promise<MovieRecorderSnapshot> { return this.fetchSnapshot() }
  async refresh(): Promise<MovieRecorderSnapshot> {
    const snapshot = await this.fetchSnapshot(); await this.publish(snapshot); return snapshot
  }
  async start(): Promise<void> {
    this.stop(); this.running = true; this.setHealth('connecting')
    try { await this.refresh(); this.setHealth('connected') } catch (error) { this.setHealth('degraded'); throw error }
    this.openSocket(); this.pollTimer = setInterval(() => void this.poll(), 5_000)
  }
  stop(): void {
    this.running = false
    if (this.pollTimer) clearInterval(this.pollTimer); if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.pollTimer = null; this.reconnectTimer = null
    const socket = this.socket; this.socket = null
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
    this.setHealth('disconnected')
  }
  private setHealth(health: ConnectionHealth): void { if (this.health !== health) { this.health = health; this.onHealth(health) } }
  private async publish(snapshot: MovieRecorderSnapshot): Promise<void> { this.last = snapshot; await this.onSnapshot(snapshot) }
  private async poll(): Promise<void> {
    if (!this.running || this.polling) return
    this.polling = true
    try { await this.refresh(); this.setHealth(this.socket?.readyState === WebSocket.OPEN ? 'connected' : 'degraded') }
    catch { const connected = this.health === 'connected'; this.setHealth('disconnected'); if (connected) await this.onConnectionLost() }
    finally { this.polling = false }
  }
  private openSocket(): void {
    if (!this.running) return
    let socket: WebSocket
    try { socket = new WebSocket(this.url('/remote', true), SOCKET_PROTOCOL) }
    catch { this.scheduleReconnect(); return }
    this.socket = socket
    socket.addEventListener('open', () => { if (this.socket === socket) { this.setHealth('connected'); void this.poll() } })
    socket.addEventListener('message', () => { if (this.socket === socket) void this.poll() })
    socket.addEventListener('error', () => socket.close())
    socket.addEventListener('close', () => { if (this.socket !== socket) return; this.socket = null; if (this.running) { this.setHealth('degraded'); this.scheduleReconnect() } })
  }
  private scheduleReconnect(): void { if (this.running && !this.reconnectTimer) this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.openSocket() }, 2_000) }
  private url(path: string, websocket = false): string {
    const config = this.getConfig(); const url = new URL(path, config.softron.baseUrl.endsWith('/') ? config.softron.baseUrl : `${config.softron.baseUrl}/`)
    if (websocket) url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    if (config.softron.password) url.searchParams.set('password', config.softron.password)
    return url.toString()
  }
  private async fetchSnapshot(): Promise<MovieRecorderSnapshot> {
    const options: RequestInit = { signal: AbortSignal.timeout(5_000) }
    const [infoResponse, sourceResponse, destinationResponse] = await Promise.all([
      fetch(this.url('/info'), options), fetch(this.url('/sources'), options), fetch(this.url('/destinations'), options)
    ])
    if (!infoResponse.ok || !sourceResponse.ok || !destinationResponse.ok) throw new Error(`MovieRecorder API returned ${[infoResponse, sourceResponse, destinationResponse].map((response) => response.status).join('/')}.`)
    const info = await infoResponse.json() as Record<string, unknown>
    const identity = text(info.application_name) || text(info.product_name)
    if (!identity.toLowerCase().includes('movierecorder')) throw new Error('The configured server is not Softron MovieRecorder.')
    const rawSources = await sourceResponse.json(); const rawDestinations = await destinationResponse.json()
    if (!Array.isArray(rawSources) || !Array.isArray(rawDestinations)) throw new Error('MovieRecorder returned malformed sources or destinations.')
    return {
      identity, at: new Date().toISOString(),
      sources: rawSources.map((source) => sourceFromApi(source as RawSource)).filter((source): source is SoftronSource => Boolean(source?.isEnabled)),
      destinations: rawDestinations.map((destination) => destinationFromApi(destination as RawDestination)).filter((destination): destination is SoftronDestination => Boolean(destination))
    }
  }
}
