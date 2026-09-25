const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

function json(data, status = 200) {
  return Response.json(data, { status, headers });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    const path = new URL(request.url).pathname;
    if (path === '/' && request.method === 'GET') {
      return json({ name: 'tarumi-api', demo: true, endpoints: ['GET /api/demo', 'POST /api/position'] });
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
        input = { latitude, longitude };
      } catch {
        return json({ error: 'invalid_json' }, 400);
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
