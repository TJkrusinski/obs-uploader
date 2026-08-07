import type { RecordingDateFormat } from '../shared/types.js'

function parts(date: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map((part) => [part.type, part.value]))
}

export function localDateKey(date: Date, timeZone: string): string {
  const value = parts(date, timeZone)
  return `${value.year}-${value.month}-${value.day}`
}

export function recordingFolderDate(date: Date, timeZone: string, format: RecordingDateFormat): string {
  const value = parts(date, timeZone); const year = value.year.slice(-2)
  if (format === 'M.d.yy') return `${Number(value.month)}.${Number(value.day)}.${year}`
  if (format === 'MM.dd.yy') return `${value.month}.${value.day}.${year}`
  return `${year}-${value.month}-${value.day}`
}

export function deterministicProjectName(date: Date, timeZone: string, recordingName?: string): string {
  const value = parts(date, timeZone)
  const timestamp = `${value.year}-${value.month}-${value.day}_${value.hour}-${value.minute}-${value.second}`
  const name = recordingName?.trim()
  return name && name !== 'Untitled Recording' ? `${name} ${timestamp}` : timestamp
}

export type DayEligibility = 'today' | 'before_today' | 'after_today' | 'unknown'
export function dayEligibility(date: Date | null, now: Date, timeZone: string): DayEligibility {
  if (!date || !Number.isFinite(date.getTime())) return 'unknown'
  const candidate = localDateKey(date, timeZone); const today = localDateKey(now, timeZone)
  return candidate === today ? 'today' : candidate < today ? 'before_today' : 'after_today'
}

export function parseApiDate(value: string): Date | null {
  if (!value) return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null
}
