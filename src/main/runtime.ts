import type { AppSnapshot, ConnectionHealth, EditableConfig, HealthSnapshot } from '../shared/types.js'
import { ConfigStore } from './config.js'
import { RecordingCoordinator } from './coordinator.js'
import { DescriptClient } from './descript.js'
import { ffprobeVersion } from './media.js'
import { RecordLedger } from './ledger.js'
import { MovieRecorderClient, resolveDestinations } from './softron.js'

export class ApplicationRuntime {
  readonly startedAt = new Date().toISOString()
  readonly descript: DescriptClient
  readonly coordinator: RecordingCoordinator
  readonly movierecorder: MovieRecorderClient
  private subscribers = new Set<() => void>()
  private verification: { descript: { ok: boolean; at: string } | null; softron: { ok: boolean; at: string } | null } = { descript: null, softron: null }
  private watcher: HealthSnapshot['watcher'] = 'standby'
  private recovery: HealthSnapshot['recovery'] = 'pending'
  private ffprobe: HealthSnapshot['ffprobe'] = 'unknown'
  private destinations: HealthSnapshot['destinations'] = 'unknown'
  constructor(readonly config: ConfigStore, readonly ledger: RecordLedger, readonly version: string, readonly bootstrapToken: string) {
    this.descript = new DescriptClient(() => this.config.get(), ledger)
    this.coordinator = new RecordingCoordinator(config, ledger, this.descript, () => this.emit())
    this.movierecorder = new MovieRecorderClient(
      () => this.config.get(), async (snapshot) => {
        const resolved = await resolveDestinations(snapshot.destinations, this.config.get())
        this.destinations = resolved.every((item) => item.readable) ? 'ready' : 'unresolved'
        await this.coordinator.onSnapshot(snapshot); this.emit()
      }, () => this.emit(), async () => this.coordinator.connectionLost()
    )
  }
  subscribe(callback: () => void): () => void { this.subscribers.add(callback); return () => this.subscribers.delete(callback) }
  private emit(): void { this.subscribers.forEach((callback) => callback()) }
  async initialize(): Promise<void> {
    this.recovery = 'running'; this.emit()
    try { await this.coordinator.recover(); this.recovery = 'complete' }
    catch (error) { this.recovery = 'error'; await this.ledger.addActivity('error', `Recovery failed: ${error instanceof Error ? error.message : String(error)}`) }
    try { await ffprobeVersion(this.config.get().tools.ffprobePath); this.ffprobe = 'available' } catch { this.ffprobe = 'unavailable' }
    if (this.config.get().desiredMode === 'watching') {
      try { await this.enterMode('watching', false) } catch (error) { this.watcher = 'error'; await this.ledger.addActivity('error', `Could not restore watching mode: ${error instanceof Error ? error.message : String(error)}`) }
    }
    this.emit()
  }
  snapshot(): AppSnapshot {
    const config = this.config.get(); const remote = this.movierecorder.getSnapshot()
    const health: HealthSnapshot = {
      server: 'ok', configuration: this.config.isValid() ? 'valid' : 'invalid', movierecorder: this.movierecorder.getHealth(), destinations: this.destinations, ffprobe: this.ffprobe,
      descript: !config.descript.apiKey ? 'missing' : this.verification.descript?.ok === true ? 'verified' : this.verification.descript?.ok === false ? 'rejected' : 'configured',
      watcher: this.watcher, recovery: this.recovery
    }
    const destinations = remote ? remote.destinations.map((destination) => {
      const recordDestination = this.ledger.active()?.destinations.find((item) => item.uniqueId === destination.uniqueId)
      return recordDestination ?? { ...destination, localPath: config.softron.destinationMappings[destination.uniqueId] ?? destination.path, readable: this.destinations === 'ready' }
    }) : []
    return {
      version: this.version, startedAt: this.startedAt, mode: config.desiredMode, health,
      config: this.config.redacted(this.verification), softron: { sources: remote?.sources ?? [], destinations, lastSuccessfulSnapshot: remote?.at ?? null },
      records: this.ledger.records(), activity: this.ledger.activity(), bootstrapToken: this.bootstrapToken
    }
  }
  async enterMode(mode: 'standby' | 'watching', persist = true): Promise<void> {
    if (persist) await this.config.setMode(mode)
    if (mode === 'standby') { this.movierecorder.stop(); this.watcher = 'standby'; await this.ledger.addActivity('info', 'Entered standby mode.'); this.emit(); return }
    this.watcher = 'starting'; this.emit()
    try {
      const snapshot = await this.movierecorder.test(); await this.coordinator.assertDestinations(snapshot)
      await this.movierecorder.start(); this.watcher = 'watching'; await this.ledger.addActivity('success', 'Watching MovieRecorder sources and destinations.')
    } catch (error) { this.watcher = 'error'; this.emit(); throw error }
    this.emit()
  }
  async updateConfig(input: EditableConfig): Promise<void> { await this.config.updateEditable(input); this.emit() }
  async testMovieRecorder(): Promise<{ ok: boolean; message: string }> {
    try {
      const snapshot = await this.movierecorder.refresh(); await this.coordinator.assertDestinations(snapshot)
      this.verification.softron = { ok: true, at: new Date().toISOString() }; this.destinations = 'ready'; this.emit()
      return { ok: true, message: `Connected to ${snapshot.identity}; found ${snapshot.sources.length} enabled source(s).` }
    } catch (error) { this.verification.softron = { ok: false, at: new Date().toISOString() }; this.emit(); return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  }
  async testDescript(): Promise<{ ok: boolean; message: string }> {
    const result = await this.descript.test(); this.verification.descript = { ok: result.ok, at: new Date().toISOString() }; this.emit(); return result
  }
  async skip(id: string): Promise<void> { await this.ledger.transition(id, 'skipped', 'Skipped by the operator.', 'operator_skipped'); this.emit() }
  async restore(id: string): Promise<void> { const record = this.ledger.find(id); if (!record) throw new Error('Recording not found.'); await this.ledger.transition(id, 'needs_review', 'Restored for operator review.', 'operator_restored'); this.emit() }
  async shutdown(): Promise<void> { this.movierecorder.stop(); await this.config.flush(); await this.ledger.flush() }
}
