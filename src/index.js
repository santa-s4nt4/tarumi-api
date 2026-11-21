import { loadDataset, predict } from './predict.js';
import { gpsLink } from './gps-links.js';
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};

function json(data, status = 200) {
  return Response.json(data, { status, headers });
}

export default {
  async scheduled(_event, env) {
    await env.DB.prepare('DELETE FROM gps_links WHERE expires_at<=?').bind(Date.now()).run();
  },
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    const path = new URL(request.url).pathname;
    if (path === '/api/gps-links' || path.startsWith('/api/gps-links/')) {
      try { return await gpsLink(request, env.DB, path, json); }
      catch { return json({ error: 'gps_relay_unavailable' }, 503); }
    }
    const recording = path.match(/^\/api\/recordings\/(front|back)$/);
    if (recording && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare('SELECT payload FROM gps_recording_chunks WHERE direction=? ORDER BY part').bind(recording[1]).all();
        if (results.length) return new Response(results.map(row => row.payload).join(''), { headers: { ...headers, 'Content-Type': 'application/json' } });
      } catch { /* Data import may still be pending. */ }
      return json({ error: 'recording_unavailable' }, 503);
    }
    if (path === '/' && request.method === 'GET') {
      return json({ name: 'tarumi-api', demo: false, endpoints: ['GET /api/demo', 'POST /api/position', 'GET /api/recordings/{front|back}', 'POST /api/gps-links'] });
    }
    if (!['/api/demo', '/api/position'].includes(path)) {
      return json({ error: 'not_found' }, 404);
    }
    const expectedMethod = path === '/api/demo' ? 'GET' : 'POST';
    if (request.method !== expectedMethod) {
      return Response.json({ error: 'method_not_allowed' }, {
        status: 405, headers: { ...headers, Allow: expectedMethod },
      });
    }

    let input = null;
    if (path === '/api/position') {
      try {
        const body = await request.json();
        const { latitude, longitude } = body ?? {};
        if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
          typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
          return json({ error: 'invalid_coordinates', message: 'latitude (-90〜90) と longitude (-180〜180) を数値で送信してください。' }, 400);
        }
        if (!['front', 'back'].includes(body.direction)) {
          return json({ error: 'invalid_direction', message: 'direction は front（往路）または back（復路）を指定してください。' }, 400);
        }
        if (body.recordedAt !== undefined && (typeof body.recordedAt !== 'string' || !/T.*(Z|[+-]\d{2}:\d{2})$/.test(body.recordedAt) || !Number.isFinite(Date.parse(body.recordedAt)))) {
          return json({ error: 'invalid_recorded_at', message: 'recordedAt はタイムゾーン付きISO日時にしてください。' }, 400);
        }
        if (body.datasetVersion !== undefined && (typeof body.datasetVersion !== 'string' || !/^[a-f0-9]{16}$/.test(body.datasetVersion))) {
          return json({ error: 'invalid_dataset_version', message: 'datasetVersion は参照データの16桁のハッシュを指定してください。' }, 400);
        }
        input = { latitude, longitude, direction: body.direction, recordedAt: body.recordedAt, datasetVersion: body.datasetVersion };
      } catch {
        return json({ error: 'invalid_json' }, 400);
      }
    }

    if (input) {
      try {
        const dataset = await loadDataset(env.DB, input.direction);
        if (input.datasetVersion && input.datasetVersion !== dataset.version) {
          return json({ error: 'dataset_version_mismatch', message: 'GPS記録とAPIの参照データのバージョンが一致しません。APIのデータを更新して再接続してください。',
            datasetVersion: dataset.version, requestedDatasetVersion: input.datasetVersion }, 409);
        }
        const result = predict(dataset, input);
        if (!result) return json({ error: 'outside_recorded_route', message: '記録された走行ルートから100m以内に対応位置がありません。', coverage: dataset.coverage }, 422);
        return json({ ...result, datasetVersion: dataset.version });
      } catch (error) {
        console.error('Reference dataset unavailable:', error.message);
        return json({ error: 'dataset_unavailable', message: 'npm run data:local または data:remote で走行データを登録してください。' }, 503);
      }
    }

    try {
      const { results } = await env.DB.prepare(
        'SELECT id, type, name, eta_seconds AS etaSeconds FROM demo_events ORDER BY eta_seconds',
      ).all();
      return json({
        demo: true,
        source: 'd1',
        message: 'D1から取得した固定のダミーデータです。GPSによる位置判定・時間予測は未実装です。',
        input,
        position: null,
        upcoming: results,
      });
    } catch {
      return json({ error: 'database_unavailable', message: 'D1の接続設定とマイグレーションの適用を確認してください。' }, 503);
    }
  },
};
