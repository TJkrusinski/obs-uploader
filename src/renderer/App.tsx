import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSnapshot, EditableConfig, RecordingRecord } from '../shared/types'

const label = (value: string) => value.replaceAll('_', ' ')
const when = (value: string | null) => value ? new Date(value).toLocaleString() : '—'

export function App() {
  const [state, setState] = useState<AppSnapshot | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [form, setForm] = useState<EditableConfig | null>(null)
  const token = useRef('')

  const receive = (snapshot: AppSnapshot) => { token.current = snapshot.bootstrapToken; setState(snapshot); setForm((current) => current ?? editable(snapshot)) }
  useEffect(() => {
    let events: EventSource | null = null; let disposed = false
    void fetch('/api/snapshot').then(async (response) => {
      if (!response.ok) throw new Error('The administration API is unavailable.')
      const snapshot = await response.json() as AppSnapshot; if (disposed) return; receive(snapshot)
      events = new EventSource('/api/events'); events.addEventListener('snapshot', (event) => receive(JSON.parse((event as MessageEvent).data) as AppSnapshot))
    }).catch((error) => setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) }))
    return () => { disposed = true; events?.close() }
  }, [])

  async function mutate(path: string, body: unknown = {}): Promise<unknown> {
    setBusy(path); setMessage(null)
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bootstrap-Token': token.current }, body: JSON.stringify(body) })
      const result = await response.json() as { error?: { message?: string }; ok?: boolean; message?: string }
      if (!response.ok) throw new Error(result.error?.message ?? 'Request failed.')
      if (typeof result.message === 'string') setMessage({ ok: result.ok !== false, text: result.message })
      return result
    } catch (error) { setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) }); throw error }
    finally { setBusy(null) }
  }

  if (!state || !form) return <main className="loading">Loading Movie Recorder Upload…</main>
  const active = state.records.find((record) => ['recording', 'connection_lost', 'finalizing', 'validating', 'reconciling', 'uploading', 'processing'].includes(record.status))
  const selectedSources = state.softron.sources.filter((source) => !state.config.softron.enabledSourceIds.length || state.config.softron.enabledSourceIds.includes(source.uniqueId))
  const counts = state.records.reduce<Record<string, number>>((result, record) => ({ ...result, [record.status]: (result[record.status] ?? 0) + 1 }), {})

  return <div className="app-shell"><main className="content">
    <header className="page-header"><div><p className="eyebrow">SOFTRON → DESCRIPT</p><h1>Movie Recorder Upload</h1><p className="subtitle">Local administration · v{state.version}</p></div>
      <div className="mode-control"><span className={`pulse ${state.mode}`}/><strong>{state.mode === 'watching' ? 'Watching' : 'Standby'}</strong>
        <button className="button primary" disabled={Boolean(busy)} onClick={() => void mutate('/api/mode', { mode: state.mode === 'watching' ? 'standby' : 'watching' })}>{state.mode === 'watching' ? 'Enter standby' : 'Start watching'}</button></div>
    </header>
    {message && <div className={`notice ${message.ok ? 'success' : 'error'}`}>{message.text}<button onClick={() => setMessage(null)}>×</button></div>}
    {state.config.warnings.map((warning) => <div className="notice error" key={warning}>{warning}</div>)}

    <section className="connection-grid">
      <Health title="MovieRecorder" status={state.health.movierecorder} detail={state.softron.lastSuccessfulSnapshot ? `Snapshot ${when(state.softron.lastSuccessfulSnapshot)}` : 'No snapshot yet'} action="Test & refresh" onAction={() => void mutate('/api/test/movierecorder')}/>
      <Health title="Destinations" status={state.health.destinations} detail={`${state.softron.destinations.filter((item) => item.readable).length}/${state.softron.destinations.length} locally readable`}/>
      <Health title="FFprobe" status={state.health.ffprobe} detail={state.config.tools.ffprobePath}/>
      <Health title="Descript" status={state.health.descript} detail={state.config.secrets.descriptApiKey.configured ? 'Key configured in config.json' : 'Add API key to config.json'} action="Verify key" onAction={() => void mutate('/api/test/descript')}/>
    </section>

    <section className="source-panel panel"><div className="panel-heading"><div><h2>MovieRecorder channels</h2><p>Selected sources retain API order; channel 1 is Program.</p></div><span className="count-chip">{selectedSources.length} selected</span></div>
      <div className="source-grid">{selectedSources.length ? selectedSources.map((source, index) => <div className={`source-card ${source.isRecording ? 'live' : ''}`} key={source.uniqueId}>
        <div><strong>Channel {index + 1} · {source.displayName}</strong><code>{source.uniqueId}</code></div><span className={`status-badge ${source.isRecording ? 'recording' : 'completed'}`}>{source.isRecording ? 'Recording' : index === 0 ? 'Program' : 'ISO'}</span>
        <small>{source.recordingName || 'No recording name'} · {source.enabledDestinationIds.length} destination(s)</small>
      </div>) : <div className="empty-state">Test MovieRecorder to discover sources.</div>}</div>
    </section>

    {active && <Active record={active}/>}

    <section className="dashboard-grid"><div className="panel"><div className="panel-heading"><div><h2>Queue & history</h2><p>Today-only work and durable prior activity.</p></div><span className="count-chip">{state.records.length}</span></div>
      <div className="stat-strip">{['recording', 'validating', 'uploading', 'processing', 'needs_review', 'completed'].map((status) => <div key={status}><strong>{counts[status] ?? 0}</strong><span>{label(status)}</span></div>)}</div>
      {state.records.length ? state.records.map((record) => <RecordRow key={record.id} record={record} expanded={expanded === record.id} toggle={() => setExpanded(expanded === record.id ? null : record.id)} busy={Boolean(busy)} mutate={mutate}/>) : <div className="empty-state">No sessions have been recorded yet.</div>}
    </div><aside className="panel activity-panel"><div className="panel-heading"><h2>Recent activity</h2></div><div className="activity-list">{state.activity.map((item) => <div className="activity-item" key={item.id}><span className={`activity-dot ${item.level}`}/><div><p>{item.message}</p><span>{when(item.at)}</span></div></div>)}</div></aside></section>

    <section className="settings-anchor"><header className="settings-header"><p className="eyebrow">CONFIGURATION</p><h1>Settings</h1><p>Secrets stay in <code>{state.config.configPath}</code> and are never returned to this page.</p></header>
      <div className="settings-layout"><div className="settings-stack">
        <SettingsCard title="MovieRecorder" description="Connection, stable source selection, and mounted destination paths.">
          <label>Base URL<input value={form.softron.baseUrl} onChange={(event) => setForm({ ...form, softron: { ...form.softron, baseUrl: event.target.value } })}/></label>
          <label>Enabled source IDs<textarea value={form.softron.enabledSourceIds.join('\n')} onChange={(event) => setForm({ ...form, softron: { ...form.softron, enabledSourceIds: lines(event.target.value) } })}/></label>
          <p className="field-help">Channel 1 is always Program. Channels 2 through N are ISO tracks in ascending order.</p>
          <label>Destination mappings <small>One “destination-id=/local/path” per line</small><textarea value={mappingText(form.softron.destinationMappings)} onChange={(event) => setForm({ ...form, softron: { ...form.softron, destinationMappings: mappings(event.target.value) } })}/></label>
        </SettingsCard>
        <SettingsCard title="Descript & validation" description="Naming uses the configured local calendar—not UTC.">
          <label>Destination root<input value={form.descript.destinationRoot} onChange={(event) => setForm({ ...form, descript: { ...form.descript, destinationRoot: event.target.value } })}/></label>
          <label>Recording timezone<input value={form.descript.recordingTimezone} onChange={(event) => setForm({ ...form, descript: { ...form.descript, recordingTimezone: event.target.value } })}/></label>
          <label>Date folder format<select value={form.descript.recordingDateFormat} onChange={(event) => setForm({ ...form, descript: { ...form.descript, recordingDateFormat: event.target.value as EditableConfig['descript']['recordingDateFormat'] } })}><option>yy-MM-dd</option><option>M.d.yy</option><option>MM.dd.yy</option></select></label>
          <label>FFprobe path<input value={form.tools.ffprobePath} onChange={(event) => setForm({ ...form, tools: { ffprobePath: event.target.value } })}/></label>
        </SettingsCard>
        <SettingsCard title="Local server" description="The server always binds to loopback."><label>Port<input type="number" value={form.server.port} onChange={(event) => setForm({ ...form, server: { ...form.server, port: Number(event.target.value) } })}/></label><label className="check"><input type="checkbox" checked={form.server.openBrowser} onChange={(event) => setForm({ ...form, server: { ...form.server, openBrowser: event.target.checked } })}/> Open browser on launch</label></SettingsCard>
      </div><aside className="help-card"><h2>Secret setup</h2><ol><li>Stop the process.</li><li>Edit <code>{state.config.configPath}</code>.</li><li>Set <code>descript.apiKey</code> and optional <code>softron.password</code>.</li><li>Restart, then verify both connections here.</li></ol></aside></div>
      <footer className="settings-footer"><button className="button secondary" onClick={() => setForm(editable(state))}>Discard</button><button className="button primary" disabled={Boolean(busy)} onClick={() => void mutate('/api/config', form).then(() => setMessage({ ok: true, text: 'Settings saved. Connection changes apply to future sessions.' }))}>Save settings</button></footer>
    </section>
  </main></div>
}

function editable(state: AppSnapshot): EditableConfig { return { desiredMode: state.mode, server: state.config.server, softron: state.config.softron, descript: state.config.descript, tools: state.config.tools } }
const lines = (value: string) => value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean)
const mappingText = (value: Record<string, string>) => Object.entries(value).map(([id, path]) => `${id}=${path}`).join('\n')
const mappings = (value: string) => Object.fromEntries(lines(value).map((line) => { const index = line.indexOf('='); return index > 0 ? [line.slice(0, index).trim(), line.slice(index + 1).trim()] : [line, ''] }).filter((entry) => entry[0] && entry[1]))

function Health({ title, status, detail, action, onAction }: { title: string; status: string; detail: string; action?: string; onAction?: () => void }) {
  return <div className="connection-card"><div className="connection-top"><span>{title}</span><span className={`pill ${status}`}>{label(status)}</span></div><strong>{detail}</strong>{action && <button className="chip-action" onClick={onAction}>{action}</button>}</div>
}
function SettingsCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <section className="setting-card"><div className="setting-card-header"><h2>{title}</h2><p>{description}</p></div><div className="form-fields">{children}</div></section> }
function Active({ record }: { record: RecordingRecord }) { return <section className="active-session panel"><div><span className="live-dot"/><p className="eyebrow">ACTIVE GANG</p><h2>{record.descriptProjectName}</h2><p>{record.sources.length} participating source(s) · {record.files.length} discovered file(s)</p></div><span className={`status-badge ${record.status}`}>{label(record.status)}</span></section> }

function RecordRow({ record, expanded, toggle, busy, mutate }: { record: RecordingRecord; expanded: boolean; toggle: () => void; busy: boolean; mutate: (path: string, body?: unknown) => Promise<unknown> }) {
  return <div className="session-block"><button className="recording-row" onClick={toggle}><span className="disclosure">{expanded ? '−' : '+'}</span><div className="recording-name"><strong>{record.descriptProjectName}</strong><span>{when(record.sessionStart)} · {record.files.length} file(s)</span></div><div className="recording-destination"><strong>{record.descriptFolder}</strong><span>{record.eligibilityDate ?? 'Unknown day'}</span></div><span className={`status-badge ${record.status}`}>{label(record.status)}</span></button>
    {expanded && <div className="session-details">{record.error && <p className="session-error">{record.error}</p>}<div className="session-sync-summary"><span>Timezone {record.eligibilityTimezone}</span><span>Retries {record.retryCount}</span><span>ID {record.id}</span></div>
      <div className="session-files">{record.files.map((file) => <div className="session-file" key={file.id}><div><strong>{file.sourceLabel} · {file.role === 'primary' ? 'Program' : 'ISO'}</strong><small>{file.originalFilename}</small></div><div className="file-states"><span>{file.stability}</span><span>{file.validation?.ok ? 'valid' : file.validation ? 'invalid' : 'not probed'}</span><span>{file.uploadStatus}</span></div></div>)}</div>
      <div className="session-detail-actions"><button className="button" disabled={busy || record.status === 'completed'} onClick={() => void mutate(`/api/records/${record.id}/retry`)}>Retry / reconcile</button>
        {record.status === 'skipped' ? <button className="button" disabled={busy} onClick={() => void mutate(`/api/records/${record.id}/restore`)}>Restore to review</button> : <button className="button danger" disabled={busy || record.status === 'completed'} onClick={() => void mutate(`/api/records/${record.id}/skip`)}>Skip</button>}
      </div></div>}
  </div>
}
