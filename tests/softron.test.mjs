import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore } from '../dist-server/main/config.js'
import { RecordingCoordinator, matchSoftronSource, normalizeSoftronName } from '../dist-server/main/coordinator.js'
import { RecordLedger } from '../dist-server/main/ledger.js'
import { sourceFromApi } from '../dist-server/main/softron.js'
import { dayEligibility, localDateKey } from '../dist-server/main/time.js'

test('normalizes the live MovieRecorder naming punctuation', () => {
  assert.equal(normalizeSoftronName('8_5_2026 1_20_20 PM Cam 2.mp4'), '85202612020pmcam2mp4')
})

test('parses destination IDs and exact recording paths from a source response', () => {
  const source = sourceFromApi({
    unique_id: '2695092128-0', display_name: 'DeckLink Quad (1)', is_enabled: true,
    recording_name: '8/5/2026 1:20:20 PM Program', is_recording: false,
    enabled_destinations: [{
      destination_unique_id: 'destination-1',
      destination_recording_path: '/Users/studio/Movies/8_5_2026 1_20_20 PM Program.mp4'
    }]
  })
  assert.deepEqual(source?.enabledDestinationIds, ['destination-1'])
  assert.deepEqual(source?.recordingPaths, ['/Users/studio/Movies/8_5_2026 1_20_20 PM Program.mp4'])
})

test('associates a completed filename with its recording name', () => {
  const sources = [{
    uniqueId: 'program', displayName: 'DeckLink Quad (1)', deviceName: 'DeckLink Quad 2 (1)',
    recordingName: '8/5/2026 1:20:20 PM Program', recordingStartDate: '2026-08-05T20:20:20.891Z',
    recordingEndDate: '', enabledDestinationIds: ['destination-1'], recordingPaths: []
  }]
  assert.equal(matchSoftronSource('8_5_2026 1_20_20 PM Program.mp4', sources)?.uniqueId, 'program')
})

test('uses local calendar dates across a daylight-saving boundary', () => {
  const timezone = 'America/Los_Angeles'
  assert.equal(localDateKey(new Date('2026-03-08T07:59:59Z'), timezone), '2026-03-07')
  assert.equal(localDateKey(new Date('2026-03-08T08:00:00Z'), timezone), '2026-03-08')
  assert.equal(dayEligibility(new Date('2026-08-06T23:00:00-07:00'), new Date('2026-08-07T09:00:00-07:00'), timezone), 'before_today')
})

test('coalesces four and eight sources and waits for the final participant to stop', async () => {
  for (const count of [4, 8]) {
    const directory = await mkdtemp(join(tmpdir(), `movie-recorder-gang-${count}-`))
    try {
      const config = await ConfigStore.open(directory); const value = config.get(); const ids = Array.from({ length: count }, (_, index) => `source-${index}`)
      await config.updateEditable({
        desiredMode: 'standby', server: { port: value.server.port, openBrowser: false },
        softron: { baseUrl: value.softron.baseUrl, primarySourceId: ids[0], enabledSourceIds: ids, destinationMappings: { destination: directory } },
        descript: { destinationRoot: 'Studio', recordingTimezone: 'America/Los_Angeles', recordingDateFormat: 'yy-MM-dd' }, tools: { ffprobePath: 'ffprobe' }
      })
      const { ledger } = await RecordLedger.open(directory); const descript = { upload: async () => undefined, reconcile: async () => 'missing' }
      const coordinator = new RecordingCoordinator(config, ledger, descript, () => undefined)
      const started = new Date().toISOString()
      const sources = ids.map((id, index) => ({
        uniqueId: id, displayName: index === 0 ? 'Program' : `Camera ${index}`, deviceName: `Device ${index}`, recordingName: index === 0 ? 'Program' : `Camera ${index}`,
        recordingStartDate: started, recordingEndDate: '', isRecording: true, isPaused: false, isEnabled: true,
        enabledDestinationIds: ['destination'], recordingPaths: []
      }))
      const base = { identity: 'MovieRecorder Express', destinations: [{ uniqueId: 'destination', name: 'Records', path: directory }], at: new Date().toISOString() }
      await coordinator.onSnapshot({ ...base, sources })
      assert.equal(ledger.records().length, 1); assert.equal(ledger.records()[0].sources.length, count); assert.equal(ledger.records()[0].status, 'recording')
      await coordinator.onSnapshot({ ...base, sources: sources.map((source, index) => ({ ...source, isRecording: index === count - 1 })) })
      assert.equal(ledger.records()[0].status, 'recording')
      await coordinator.connectionLost(); assert.equal(ledger.records()[0].status, 'connection_lost')
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})
