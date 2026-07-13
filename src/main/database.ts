import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { ActivityItem, Recording, RecordingStatus } from '../shared/types.js'

export class LedgerDatabase {
  private readonly db: Database.Database

  constructor(filePath: string) {
    this.db = new Database(filePath)
    this.db.pragma('journal_mode = WAL')
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
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
    `)
  }

  getRecordings(): Recording[] {
    return this.db.prepare('SELECT * FROM recordings ORDER BY recorded_at DESC').all().map(mapRecording)
  }
  getRecording(id: string): Recording | undefined {
    const row = this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id)
    return row ? mapRecording(row) : undefined
  }
  getByPath(localPath: string): Recording | undefined {
    const row = this.db.prepare('SELECT * FROM recordings WHERE local_path = ?').get(localPath)
    return row ? mapRecording(row) : undefined
  }
  create(recording: Omit<Recording, 'id' | 'status' | 'errorMessage' | 'discoveredAt' | 'updatedAt'>): Recording {
    const now = new Date().toISOString()
    const result: Recording = { ...recording, id: randomUUID(), status: 'waiting', errorMessage: null, discoveredAt: now, updatedAt: now }
    this.db.prepare(`INSERT INTO recordings VALUES (@id,@localPath,@originalFilename,@recordedAt,@fileSize,@descriptFolderPath,@descriptProjectName,@descriptProjectId,@descriptJobId,@status,@errorMessage,@discoveredAt,@updatedAt)`).run(result)
    return result
  }
  update(id: string, values: Partial<Pick<Recording, 'status' | 'errorMessage' | 'descriptProjectId' | 'descriptJobId'>>): void {
    const columns = Object.keys(values)
    if (!columns.length) return
    const translation: Record<string, string> = { descriptProjectId: 'descript_project_id', descriptJobId: 'descript_job_id', errorMessage: 'error_message' }
    const set = columns.map((key) => `${translation[key] ?? key} = @${key}`).join(', ')
    this.db.prepare(`UPDATE recordings SET ${set}, updated_at = @updatedAt WHERE id = @id`).run({ ...values, id, updatedAt: new Date().toISOString() })
  }
  getPending(): Recording[] {
    return this.db.prepare("SELECT * FROM recordings WHERE status IN ('waiting','uploading','processing') ORDER BY discovered_at ASC").all().map(mapRecording)
  }
  getActivity(): ActivityItem[] {
    return this.db.prepare('SELECT * FROM activity ORDER BY created_at DESC LIMIT 20').all().map((row: any) => ({ id: row.id, kind: row.kind, message: row.message, createdAt: row.created_at }))
  }
  addActivity(kind: ActivityItem['kind'], message: string): void {
    this.db.prepare('INSERT INTO activity VALUES (?, ?, ?, ?)').run(randomUUID(), kind, message, new Date().toISOString())
  }
  close(): void { this.db.close() }
}

function mapRecording(row: any): Recording {
  return {
    id: row.id, localPath: row.local_path, originalFilename: row.original_filename, recordedAt: row.recorded_at,
    fileSize: row.file_size, descriptFolderPath: row.descript_folder_path, descriptProjectName: row.descript_project_name,
    descriptProjectId: row.descript_project_id, descriptJobId: row.descript_job_id, status: row.status as RecordingStatus,
    errorMessage: row.error_message, discoveredAt: row.discovered_at, updatedAt: row.updated_at
  }
}
