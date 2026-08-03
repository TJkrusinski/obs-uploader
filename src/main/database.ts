import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  ActivityItem, CaptureSession, CaptureSessionStatus, RecorderType, SessionFile,
  SessionFileStabilityStatus, SessionFileUploadStatus
} from '../shared/types.js'

type NewSession = Omit<CaptureSession, 'id' | 'errorMessage' | 'hidden' | 'uploadExcluded' | 'createdAt' | 'updatedAt' | 'files'>
export type NewSessionFile = Omit<SessionFile, 'id' | 'sessionId' | 'errorMessage' | 'discoveredAt' | 'updatedAt'>

export class LedgerDatabase {
  private readonly db: Database.Database

  constructor(filePath: string) {
    this.db = new Database(filePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY,
        local_path TEXT NOT NULL UNIQUE,
        original_filename TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        descript_folder_path TEXT NOT NULL,
        descript_project_name TEXT NOT NULL,
        descript_project_id TEXT,
        descript_job_id TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        hidden INTEGER NOT NULL DEFAULT 0,
        upload_excluded INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capture_sessions (
        id TEXT PRIMARY KEY,
        recorder_type TEXT NOT NULL,
        status TEXT NOT NULL,
        session_start TEXT NOT NULL,
        session_end TEXT,
        finalization_source TEXT,
        descript_folder_path TEXT NOT NULL,
        descript_project_name TEXT NOT NULL,
        descript_project_id TEXT,
        descript_job_id TEXT,
        descript_project_url TEXT,
        timeline_timebase INTEGER,
        timeline_ntsc INTEGER,
        sync_mode TEXT NOT NULL DEFAULT 'unknown',
        manifest_path TEXT,
        manifest_hash TEXT,
        import_attempt_id TEXT,
        import_payload_hash TEXT,
        configuration_snapshot TEXT NOT NULL,
        error_message TEXT,
        hidden INTEGER NOT NULL DEFAULT 0,
        upload_excluded INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_files (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        location_id TEXT NOT NULL,
        source_label TEXT NOT NULL,
        source_role TEXT NOT NULL,
        local_path TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        descript_media_key TEXT NOT NULL,
        content_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        segment_index INTEGER NOT NULL,
        manifest_track_index INTEGER,
        manifest_clip_index INTEGER,
        manifest_clip_id TEXT,
        timeline_start_frame INTEGER,
        timeline_end_frame INTEGER,
        stability_status TEXT NOT NULL,
        upload_status TEXT NOT NULL,
        error_message TEXT,
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES capture_sessions(id)
      );
      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_capture_sessions_status ON capture_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_session_files_session ON session_files(session_id);
    `)
    this.ensureLegacyColumns()
    this.removeLegacySessionFilePathUniqueness()
    this.migrateLegacyRecordings()
    this.markInterruptedUploadsForReview()
  }
  private markInterruptedUploadsForReview(): void {
    const recover = this.db.transaction(() => {
      const interrupted = this.db.prepare("SELECT id FROM capture_sessions WHERE status = 'uploading'").all() as Array<{ id: string }>
      const now = new Date().toISOString()
      for (const session of interrupted) {
        this.db.prepare("UPDATE capture_sessions SET status = 'needs_review', error_message = ?, updated_at = ? WHERE id = ?").run('The application closed during file transfer. The stored Descript job must be reviewed before retrying.', now, session.id)
        this.db.prepare("UPDATE session_files SET upload_status = 'failed', error_message = ?, updated_at = ? WHERE session_id = ? AND upload_status = 'uploading'").run('Transfer was interrupted when the application closed.', now, session.id)
      }
    })
    recover()
  }

  private ensureLegacyColumns(): void {
    const columns = this.db.pragma('table_info(recordings)') as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'hidden')) this.db.exec('ALTER TABLE recordings ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
    if (!columns.some((column) => column.name === 'deleted')) this.db.exec('ALTER TABLE recordings ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0')
    const sessionColumns = this.db.pragma('table_info(capture_sessions)') as Array<{ name: string }>
    if (!sessionColumns.some((column) => column.name === 'upload_excluded')) this.db.exec('ALTER TABLE capture_sessions ADD COLUMN upload_excluded INTEGER NOT NULL DEFAULT 0')
    if (!sessionColumns.some((column) => column.name === 'descript_project_url')) this.db.exec('ALTER TABLE capture_sessions ADD COLUMN descript_project_url TEXT')
    if (!sessionColumns.some((column) => column.name === 'timeline_timebase')) this.db.exec('ALTER TABLE capture_sessions ADD COLUMN timeline_timebase INTEGER')
    if (!sessionColumns.some((column) => column.name === 'timeline_ntsc')) this.db.exec('ALTER TABLE capture_sessions ADD COLUMN timeline_ntsc INTEGER')
    if (!sessionColumns.some((column) => column.name === 'sync_mode')) this.db.exec("ALTER TABLE capture_sessions ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'unknown'")
    if (!sessionColumns.some((column) => column.name === 'manifest_path')) this.db.exec('ALTER TABLE capture_sessions ADD COLUMN manifest_path TEXT')
    if (!sessionColumns.some((column) => column.name === 'manifest_hash')) this.db.exec('ALTER TABLE capture_sessions ADD COLUMN manifest_hash TEXT')
    if (!sessionColumns.some((column) => column.name === 'import_attempt_id')) this.db.exec('ALTER TABLE capture_sessions ADD COLUMN import_attempt_id TEXT')
    if (!sessionColumns.some((column) => column.name === 'import_payload_hash')) this.db.exec('ALTER TABLE capture_sessions ADD COLUMN import_payload_hash TEXT')
    const fileColumns = this.db.pragma('table_info(session_files)') as Array<{ name: string }>
    if (!fileColumns.some((column) => column.name === 'manifest_track_index')) this.db.exec('ALTER TABLE session_files ADD COLUMN manifest_track_index INTEGER')
    if (!fileColumns.some((column) => column.name === 'manifest_clip_index')) this.db.exec('ALTER TABLE session_files ADD COLUMN manifest_clip_index INTEGER')
    if (!fileColumns.some((column) => column.name === 'manifest_clip_id')) this.db.exec('ALTER TABLE session_files ADD COLUMN manifest_clip_id TEXT')
    if (!fileColumns.some((column) => column.name === 'timeline_start_frame')) this.db.exec('ALTER TABLE session_files ADD COLUMN timeline_start_frame INTEGER')
    if (!fileColumns.some((column) => column.name === 'timeline_end_frame')) this.db.exec('ALTER TABLE session_files ADD COLUMN timeline_end_frame INTEGER')
  }
  private removeLegacySessionFilePathUniqueness(): void {
    const table = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_files'").get() as { sql?: string } | undefined
    if (!table?.sql || !/local_path\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(table.sql)) return
    this.db.pragma('foreign_keys = OFF')
    try {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE session_files_rebuilt (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            location_id TEXT NOT NULL,
            source_label TEXT NOT NULL,
            source_role TEXT NOT NULL,
            local_path TEXT NOT NULL,
            original_filename TEXT NOT NULL,
            descript_media_key TEXT NOT NULL,
            content_type TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            modified_at TEXT NOT NULL,
            segment_index INTEGER NOT NULL,
            manifest_track_index INTEGER,
            manifest_clip_index INTEGER,
            manifest_clip_id TEXT,
            timeline_start_frame INTEGER,
            timeline_end_frame INTEGER,
            stability_status TEXT NOT NULL,
            upload_status TEXT NOT NULL,
            error_message TEXT,
            discovered_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES capture_sessions(id)
          );
          INSERT INTO session_files_rebuilt
          (id,session_id,location_id,source_label,source_role,local_path,original_filename,descript_media_key,content_type,file_size,modified_at,segment_index,manifest_track_index,manifest_clip_index,manifest_clip_id,timeline_start_frame,timeline_end_frame,stability_status,upload_status,error_message,discovered_at,updated_at)
          SELECT id,session_id,location_id,source_label,source_role,local_path,original_filename,descript_media_key,content_type,file_size,modified_at,segment_index,manifest_track_index,manifest_clip_index,manifest_clip_id,timeline_start_frame,timeline_end_frame,stability_status,upload_status,error_message,discovered_at,updated_at
          FROM session_files;
          DROP TABLE session_files;
          ALTER TABLE session_files_rebuilt RENAME TO session_files;
          CREATE INDEX idx_session_files_session ON session_files(session_id);
          CREATE INDEX idx_session_files_path ON session_files(local_path);
        `)
      })()
    } finally {
      this.db.pragma('foreign_keys = ON')
    }
  }
  private migrateLegacyRecordings(): void {
    const migrate = this.db.transaction(() => {
      const rows = this.db.prepare('SELECT * FROM recordings').all() as any[]
      const insertSession = this.db.prepare(`
        INSERT OR IGNORE INTO capture_sessions
        (id,recorder_type,status,session_start,session_end,finalization_source,descript_folder_path,descript_project_name,descript_project_id,descript_job_id,descript_project_url,timeline_timebase,timeline_ntsc,sync_mode,manifest_path,manifest_hash,import_attempt_id,import_payload_hash,configuration_snapshot,error_message,hidden,upload_excluded,deleted,created_at,updated_at)
        VALUES (@id,'obs',@status,@recorded_at,@session_end,'obs_event',@descript_folder_path,@descript_project_name,@descript_project_id,@descript_job_id,NULL,NULL,NULL,'unknown',NULL,NULL,NULL,NULL,@snapshot,@error_message,@hidden,0,@deleted,@discovered_at,@updated_at)
      `)
      const insertFile = this.db.prepare(`
        INSERT OR IGNORE INTO session_files
        (id,session_id,location_id,source_label,source_role,local_path,original_filename,descript_media_key,content_type,file_size,modified_at,segment_index,manifest_track_index,manifest_clip_index,manifest_clip_id,timeline_start_frame,timeline_end_frame,stability_status,upload_status,error_message,discovered_at,updated_at)
        VALUES (@file_id,@id,'legacy-primary','Program','primary',@local_path,@original_filename,@original_filename,@content_type,@file_size,@updated_at,0,NULL,NULL,NULL,NULL,NULL,'stable',@upload_status,@file_error,@discovered_at,@updated_at)
      `)
      for (const row of rows) {
        const status = legacySessionStatus(row.status)
        insertSession.run({
          ...row, status, session_end: row.recorded_at,
          snapshot: JSON.stringify({ recorderType: 'obs', legacy: true, recordingsDirectory: null })
        })
        insertFile.run({
          ...row, file_id: `legacy-file-${row.id}`, content_type: mediaContentType(row.local_path),
          upload_status: legacyUploadStatus(row.status), file_error: row.status === 'failed' ? row.error_message : null
        })
      }
    })
    migrate()
  }

  getSessions(): CaptureSession[] {
    const rows = this.db.prepare('SELECT * FROM capture_sessions WHERE deleted = 0 ORDER BY session_start DESC').all()
    return rows.map((row) => this.mapSession(row))
  }
  getSession(id: string): CaptureSession | undefined {
    const row = this.db.prepare('SELECT * FROM capture_sessions WHERE id = ?').get(id)
    return row ? this.mapSession(row) : undefined
  }
  getByPath(localPath: string): SessionFile | undefined {
    const row = this.db.prepare('SELECT * FROM session_files WHERE local_path = ?').get(localPath)
    return row ? mapSessionFile(row) : undefined
  }
  getVmixSessionByManifest(manifestPath: string, manifestKey: string): CaptureSession | undefined {
    const row = this.db.prepare(`
      SELECT * FROM capture_sessions
      WHERE recorder_type = 'vmix'
        AND (
          manifest_path = ?
          OR (
            json_valid(configuration_snapshot)
            AND (
              json_extract(configuration_snapshot, '$.manifestKey') = ?
              OR json_extract(configuration_snapshot, '$.manifestPath') = ?
            )
          )
        )
      LIMIT 1
    `).get(manifestPath, manifestKey, manifestPath)
    return row ? this.mapSession(row) : undefined
  }
  createSession(session: NewSession, files: NewSessionFile[]): CaptureSession {
    const now = new Date().toISOString()
    const id = randomUUID()
    const descriptProjectName = this.availableProjectName(session.descriptFolderPath, session.descriptProjectName)
    const insert = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO capture_sessions
        (id,recorder_type,status,session_start,session_end,finalization_source,descript_folder_path,descript_project_name,descript_project_id,descript_job_id,descript_project_url,timeline_timebase,timeline_ntsc,sync_mode,manifest_path,manifest_hash,import_attempt_id,import_payload_hash,configuration_snapshot,error_message,hidden,upload_excluded,created_at,updated_at)
        VALUES (@id,@recorderType,@status,@sessionStart,@sessionEnd,@finalizationSource,@descriptFolderPath,@descriptProjectName,@descriptProjectId,@descriptJobId,@descriptProjectUrl,@timelineTimebase,@timelineNtsc,@syncMode,@manifestPath,@manifestHash,@importAttemptId,@importPayloadHash,@configurationSnapshot,NULL,0,0,@createdAt,@updatedAt)
      `).run({
        ...session,
        timelineNtsc: session.timelineNtsc == null ? null : Number(session.timelineNtsc),
        descriptProjectName, id, createdAt: now, updatedAt: now
      })
      const statement = this.db.prepare(`
        INSERT INTO session_files
        (id,session_id,location_id,source_label,source_role,local_path,original_filename,descript_media_key,content_type,file_size,modified_at,segment_index,manifest_track_index,manifest_clip_index,manifest_clip_id,timeline_start_frame,timeline_end_frame,stability_status,upload_status,error_message,discovered_at,updated_at)
        VALUES (@id,@sessionId,@locationId,@sourceLabel,@sourceRole,@localPath,@originalFilename,@descriptMediaKey,@contentType,@fileSize,@modifiedAt,@segmentIndex,@manifestTrackIndex,@manifestClipIndex,@manifestClipId,@timelineStartFrame,@timelineEndFrame,@stabilityStatus,@uploadStatus,NULL,@discoveredAt,@updatedAt)
      `)
      files.forEach((file) => statement.run({ ...file, id: randomUUID(), sessionId: id, discoveredAt: now, updatedAt: now }))
    })
    insert()
    return this.getSession(id)!
  }
  addSessionFile(sessionId: string, file: NewSessionFile): SessionFile {
    const now = new Date().toISOString()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO session_files
      (id,session_id,location_id,source_label,source_role,local_path,original_filename,descript_media_key,content_type,file_size,modified_at,segment_index,manifest_track_index,manifest_clip_index,manifest_clip_id,timeline_start_frame,timeline_end_frame,stability_status,upload_status,error_message,discovered_at,updated_at)
      VALUES (@id,@sessionId,@locationId,@sourceLabel,@sourceRole,@localPath,@originalFilename,@descriptMediaKey,@contentType,@fileSize,@modifiedAt,@segmentIndex,@manifestTrackIndex,@manifestClipIndex,@manifestClipId,@timelineStartFrame,@timelineEndFrame,@stabilityStatus,@uploadStatus,NULL,@discoveredAt,@updatedAt)
    `).run({ ...file, id, sessionId, discoveredAt: now, updatedAt: now })
    return mapSessionFile(this.db.prepare('SELECT * FROM session_files WHERE id = ?').get(id))
  }
  private availableProjectName(folderPath: string, requestedName: string): string {
    const exists = this.db.prepare('SELECT 1 FROM capture_sessions WHERE descript_folder_path = ? AND descript_project_name = ? LIMIT 1')
    if (!exists.get(folderPath, requestedName)) return requestedName
    let suffix = 2
    while (exists.get(folderPath, `${requestedName}-${String(suffix).padStart(2, '0')}`)) suffix += 1
    return `${requestedName}-${String(suffix).padStart(2, '0')}`
  }
  updateSession(id: string, values: Partial<Pick<CaptureSession,
    'status' | 'sessionStart' | 'sessionEnd' | 'finalizationSource' | 'errorMessage' | 'descriptFolderPath' |
    'descriptProjectName' | 'descriptProjectId' | 'descriptJobId' | 'descriptProjectUrl' | 'timelineTimebase' |
    'timelineNtsc' | 'syncMode' | 'manifestPath' | 'manifestHash' | 'importAttemptId' | 'importPayloadHash' |
    'configurationSnapshot'
  >>): void {
    const columns = Object.keys(values)
    if (!columns.length) return
    const names: Record<string, string> = {
      sessionStart: 'session_start', sessionEnd: 'session_end', finalizationSource: 'finalization_source', errorMessage: 'error_message',
      descriptFolderPath: 'descript_folder_path', descriptProjectName: 'descript_project_name', descriptProjectId: 'descript_project_id',
      descriptJobId: 'descript_job_id', descriptProjectUrl: 'descript_project_url', timelineTimebase: 'timeline_timebase',
      timelineNtsc: 'timeline_ntsc', syncMode: 'sync_mode', manifestPath: 'manifest_path', manifestHash: 'manifest_hash',
      importAttemptId: 'import_attempt_id', importPayloadHash: 'import_payload_hash', configurationSnapshot: 'configuration_snapshot'
    }
    const set = columns.map((key) => `${names[key] ?? key} = @${key}`).join(', ')
    const parameters: Record<string, unknown> = { ...values, id, updatedAt: new Date().toISOString() }
    if (values.timelineNtsc !== undefined) parameters.timelineNtsc = values.timelineNtsc == null ? null : Number(values.timelineNtsc)
    this.db.prepare(`UPDATE capture_sessions SET ${set}, updated_at = @updatedAt WHERE id = @id`).run(parameters)
  }
  retryProjectName(session: CaptureSession): string {
    const previousRetry = session.descriptProjectName.match(/ \(retry (\d+)\)$/)
    const base = session.descriptProjectName.replace(/ \(retry \d+\)$/, '')
    let retry = previousRetry ? Number(previousRetry[1]) + 1 : 2
    const exists = this.db.prepare('SELECT 1 FROM capture_sessions WHERE id <> ? AND descript_folder_path = ? AND descript_project_name = ? LIMIT 1')
    while (exists.get(session.id, session.descriptFolderPath, `${base} (retry ${retry})`)) retry += 1
    return `${base} (retry ${retry})`
  }
  updateFile(id: string, values: Partial<Pick<SessionFile,
    'sourceRole' | 'uploadStatus' | 'stabilityStatus' | 'errorMessage' | 'fileSize' | 'modifiedAt' | 'localPath' |
    'manifestTrackIndex' | 'manifestClipIndex' | 'manifestClipId' | 'timelineStartFrame' | 'timelineEndFrame'
  >>): void {
    const columns = Object.keys(values)
    if (!columns.length) return
    const names: Record<string, string> = {
      sourceRole: 'source_role', uploadStatus: 'upload_status', stabilityStatus: 'stability_status', errorMessage: 'error_message',
      fileSize: 'file_size', modifiedAt: 'modified_at', localPath: 'local_path', manifestTrackIndex: 'manifest_track_index',
      manifestClipIndex: 'manifest_clip_index', manifestClipId: 'manifest_clip_id', timelineStartFrame: 'timeline_start_frame',
      timelineEndFrame: 'timeline_end_frame'
    }
    const set = columns.map((key) => `${names[key] ?? key} = @${key}`).join(', ')
    this.db.prepare(`UPDATE session_files SET ${set}, updated_at = @updatedAt WHERE id = @id`).run({ ...values, id, updatedAt: new Date().toISOString() })
  }
  replaceSessionFiles(sessionId: string, files: NewSessionFile[]): void {
    const now = new Date().toISOString()
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM session_files WHERE session_id = ?').run(sessionId)
      const statement = this.db.prepare(`
        INSERT INTO session_files
        (id,session_id,location_id,source_label,source_role,local_path,original_filename,descript_media_key,content_type,file_size,modified_at,segment_index,manifest_track_index,manifest_clip_index,manifest_clip_id,timeline_start_frame,timeline_end_frame,stability_status,upload_status,error_message,discovered_at,updated_at)
        VALUES (@id,@sessionId,@locationId,@sourceLabel,@sourceRole,@localPath,@originalFilename,@descriptMediaKey,@contentType,@fileSize,@modifiedAt,@segmentIndex,@manifestTrackIndex,@manifestClipIndex,@manifestClipId,@timelineStartFrame,@timelineEndFrame,@stabilityStatus,@uploadStatus,@errorMessage,@discoveredAt,@updatedAt)
      `)
      files.forEach((file) => statement.run({ ...file, id: randomUUID(), sessionId, errorMessage: null, discoveredAt: now, updatedAt: now }))
    })()
  }
  getPendingSessions(): CaptureSession[] {
    return this.db.prepare("SELECT * FROM capture_sessions WHERE deleted = 0 AND (status IN ('uploading','processing') OR (status = 'ready' AND upload_excluded = 0)) ORDER BY created_at ASC").all().map((row) => this.mapSession(row))
  }
  getRecoverableSessions(): CaptureSession[] {
    return this.db.prepare("SELECT * FROM capture_sessions WHERE deleted = 0 AND status IN ('recording','connection_lost','finalizing','ready','uploading','processing') ORDER BY created_at ASC").all().map((row) => this.mapSession(row))
  }
  setPrimarySource(sessionId: string, sourceLabel: string): void {
    const update = this.db.transaction(() => {
      const now = new Date().toISOString()
      this.db.prepare("UPDATE session_files SET source_role = 'iso', updated_at = ? WHERE session_id = ? AND upload_status != 'excluded'").run(now, sessionId)
      const result = this.db.prepare("UPDATE session_files SET source_role = 'primary', updated_at = ? WHERE session_id = ? AND source_label = ? AND upload_status != 'excluded'").run(now, sessionId, sourceLabel)
      if (!result.changes) throw new Error('The selected source has no included files.')
    })
    update()
  }
  setHidden(id: string, hidden: boolean): void {
    this.db.prepare('UPDATE capture_sessions SET hidden = ?, updated_at = ? WHERE id = ?').run(hidden ? 1 : 0, new Date().toISOString(), id)
  }
  setUploadExcluded(id: string, excluded: boolean): void {
    this.db.prepare('UPDATE capture_sessions SET upload_excluded = ?, updated_at = ? WHERE id = ?').run(excluded ? 1 : 0, new Date().toISOString(), id)
  }
  setHiddenMany(ids: string[], hidden: boolean): number {
    if (!ids.length) return 0
    const update = this.db.prepare('UPDATE capture_sessions SET hidden = ?, updated_at = ? WHERE id = ? AND deleted = 0')
    const transaction = this.db.transaction((sessionIds: string[]) => {
      const updatedAt = new Date().toISOString()
      let changed = 0
      for (const id of sessionIds) changed += update.run(hidden ? 1 : 0, updatedAt, id).changes
      return changed
    })
    return transaction(ids)
  }
  deleteFromQueue(id: string): void {
    this.db.prepare('UPDATE capture_sessions SET deleted = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
  }
  deleteSessions(ids: string[]): number {
    if (!ids.length) return 0
    const removeFiles = this.db.prepare('DELETE FROM session_files WHERE session_id = ?')
    const removeSession = this.db.prepare('DELETE FROM capture_sessions WHERE id = ?')
    const transaction = this.db.transaction((sessionIds: string[]) => {
      let deleted = 0
      for (const id of sessionIds) {
        removeFiles.run(id)
        deleted += removeSession.run(id).changes
      }
      return deleted
    })
    return transaction(ids)
  }
  getActivity(): ActivityItem[] {
    return this.db.prepare('SELECT * FROM activity ORDER BY created_at DESC LIMIT 20').all().map((row: any) => ({ id: row.id, kind: row.kind, message: row.message, createdAt: row.created_at }))
  }
  addActivity(kind: ActivityItem['kind'], message: string): void {
    this.db.prepare('INSERT INTO activity VALUES (?, ?, ?, ?)').run(randomUUID(), kind, message, new Date().toISOString())
  }
  close(): void { this.db.close() }

  private mapSession(row: any): CaptureSession {
    const files = this.db.prepare(`
      SELECT * FROM session_files WHERE session_id = ?
      ORDER BY CASE source_role WHEN 'primary' THEN 0 ELSE 1 END,
        COALESCE(manifest_track_index, 2147483647), COALESCE(timeline_start_frame, 2147483647),
        COALESCE(manifest_clip_index, 2147483647), segment_index, descript_media_key
    `).all(row.id).map(mapSessionFile)
    return {
      id: row.id, recorderType: row.recorder_type as RecorderType, status: row.status as CaptureSessionStatus,
      sessionStart: row.session_start, sessionEnd: row.session_end, finalizationSource: row.finalization_source,
      descriptFolderPath: row.descript_folder_path, descriptProjectName: row.descript_project_name,
      descriptProjectId: row.descript_project_id, descriptJobId: row.descript_job_id,
      descriptProjectUrl: row.descript_project_url,
      timelineTimebase: row.timeline_timebase == null ? null : Number(row.timeline_timebase),
      timelineNtsc: row.timeline_ntsc == null ? null : Boolean(row.timeline_ntsc),
      syncMode: row.sync_mode ?? 'unknown', manifestPath: row.manifest_path, manifestHash: row.manifest_hash,
      importAttemptId: row.import_attempt_id, importPayloadHash: row.import_payload_hash,
      configurationSnapshot: row.configuration_snapshot, errorMessage: row.error_message, hidden: Boolean(row.hidden),
      uploadExcluded: Boolean(row.upload_excluded),
      createdAt: row.created_at, updatedAt: row.updated_at, files
    }
  }
}

function mapSessionFile(row: any): SessionFile {
  return {
    id: row.id, sessionId: row.session_id, locationId: row.location_id, sourceLabel: row.source_label,
    sourceRole: row.source_role, localPath: row.local_path, originalFilename: row.original_filename,
    descriptMediaKey: row.descript_media_key, contentType: row.content_type, fileSize: row.file_size,
    modifiedAt: row.modified_at, segmentIndex: row.segment_index,
    manifestTrackIndex: row.manifest_track_index == null ? null : Number(row.manifest_track_index),
    manifestClipIndex: row.manifest_clip_index == null ? null : Number(row.manifest_clip_index),
    manifestClipId: row.manifest_clip_id,
    timelineStartFrame: row.timeline_start_frame == null ? null : Number(row.timeline_start_frame),
    timelineEndFrame: row.timeline_end_frame == null ? null : Number(row.timeline_end_frame),
    stabilityStatus: row.stability_status as SessionFileStabilityStatus,
    uploadStatus: row.upload_status as SessionFileUploadStatus, errorMessage: row.error_message,
    discoveredAt: row.discovered_at, updatedAt: row.updated_at
  }
}

function legacySessionStatus(status: string): CaptureSessionStatus {
  return status === 'waiting' ? 'ready' : status as CaptureSessionStatus
}
function legacyUploadStatus(status: string): SessionFileUploadStatus {
  if (status === 'completed' || status === 'processing') return 'uploaded'
  if (status === 'canceled') return 'excluded'
  if (status === 'failed') return 'failed'
  return 'pending'
}
function mediaContentType(path: string): string {
  const extension = path.toLowerCase().match(/\.[^.]+$/)?.[0] ?? ''
  return ({
    '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
    '.aiff': 'audio/aiff', '.flac': 'audio/flac', '.opus': 'audio/opus', '.aac': 'audio/aac'
  } as Record<string, string>)[extension] ?? 'application/octet-stream'
}
