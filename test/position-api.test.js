import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { xy, distance } from '../src/geometry.js';

const version = 'fb4da293da79f085';
const recording = JSON.parse(readFileSync(new URL('../data/gps-front.json', import.meta.url)));
const first = recording.records[0], second = recording.records[1];
const a = xy(first.lat, first.lon), b = xy(second.lat, second.lon);
const dataset = { direction: 'front', nodes: [[...a, 0, first.t, first.speed], [...b, distance(a, b), second.t, second.speed]],
  events: [], tunnels: [], river: [], coverage: {} };

function request(body) {
  const db = { prepare() { return { bind() { return { async all() {
    return { results: [{ part: 0, version, payload: JSON.stringify(dataset) }] };
  } }; } }; } };
  return worker.fetch(new Request('https://example.test/api/position', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ latitude: first.lat, longitude: first.lon, direction: 'front', ...body }) }), { DB: db });
}

test('the latest recording is accepted when the API has the same dataset', async () => {
  const response = await request({ datasetVersion: version });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.datasetVersion, version);
  assert.equal(result.position.matchOffsetMeters, 0);
  assert.equal(result.position.referenceTimeSeconds, first.t);
});

test('different GPS and API datasets are reported before route matching', async () => {
  const response = await request({ latitude: 36, longitude: 137, datasetVersion: '8aec7cfba1be2626' });
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.equal(result.error, 'dataset_version_mismatch');
  assert.equal(result.datasetVersion, version);
  assert.equal(result.requestedDatasetVersion, '8aec7cfba1be2626');
});

test('a real off-route position still returns 422 for the current dataset', async () => {
  const response = await request({ latitude: 36, longitude: 137, datasetVersion: version });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, 'outside_recorded_route');
});

test('existing clients may omit the dataset version', async () => {
  assert.equal((await request({})).status, 200);
});

test('invalid dataset versions are rejected', async () => {
  for (const datasetVersion of [null, 123, '', 'invalid']) {
    const response = await request({ datasetVersion });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_dataset_version');
  }
});
