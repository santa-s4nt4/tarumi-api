const lifetime = 2 * 60 * 60 * 1000;
const secret = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function gpsLink(request, db, path, json) {
  const now = Date.now();
  if (path === '/api/gps-links' && request.method === 'POST') {
    const id = crypto.randomUUID(), reader = secret(), writer = secret(), expiresAt = now + lifetime;
    await db.batch([
      db.prepare('DELETE FROM gps_links WHERE expires_at<=?').bind(now),
      db.prepare('INSERT INTO gps_links(id,reader,writer,expires_at) VALUES (?,?,?,?)')
        .bind(id, await digest(reader), await digest(writer), expiresAt),
    ]);
    return json({ id, reader, writer, expiresAt }, 201);
  }
  const match = path.match(/^\/api\/gps-links\/([a-f0-9-]{36})(\/join)?$/);
  const id = match?.[1];
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const missing = () => json({ error: 'link_unavailable' }, 404);
  if (!id || !token) return missing();
  const key = await digest(token);
  if (match[2]) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const result = await db.prepare('UPDATE gps_links SET joined_at=? WHERE id=? AND writer=? AND expires_at>?').bind(now, id, key, now).run();
    return result.meta.changes ? json({ joined: true }) : missing();
  }
  if (request.method === 'HEAD') {
    const row = await db.prepare('SELECT 1 FROM gps_links WHERE id=? AND writer=? AND expires_at>?').bind(id, key, now).first();
    const { headers } = json(null);
    return new Response(null, { status: row ? 200 : 404, headers });
  }
  if (request.method === 'GET') {
    const row = await db.prepare('SELECT fix, expires_at, joined_at, view FROM gps_links WHERE id=? AND reader=? AND expires_at>?')
      .bind(id, key, now).first();
    return row ? json({ position: JSON.parse(row.fix), expiresAt: row.expires_at, joinedAt: row.joined_at, view: JSON.parse(row.view) }) : missing();
  }
  if (request.method === 'DELETE') {
    const result = await db.prepare('DELETE FROM gps_links WHERE id=? AND (reader=? OR writer=?)')
      .bind(id, key, key).run();
    return result.meta.changes ? json({ closed: true }) : missing();
  }
  if (request.method === 'PATCH') {
    let value;
    try { value = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const { trainId, date, delay, mode } = value ?? {};
    if ((trainId !== null && (typeof trainId !== 'string' || !/^\d{1,5}$/.test(trainId))) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isInteger(delay) || delay < 0 || delay > 86400 || !['auto', 'normal', 'bird'].includes(mode)) return json({ error: 'invalid_view' }, 400);
    const result = await db.prepare('UPDATE gps_links SET view=? WHERE id=? AND reader=? AND expires_at>?')
      .bind(JSON.stringify({ trainId, date, delay, mode }), id, key, now).run();
    return result.meta.changes ? json({ saved: true }) : missing();
  }
  if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
  let input;
  try { input = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const { timestamp, latitude, longitude, accuracy, speed = null } = input ?? {};
  if (![timestamp, latitude, longitude, accuracy].every(Number.isFinite) ||
    Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy < 0 ||
    timestamp < now - 15000 || timestamp > now + 5000 ||
    (speed !== null && (!Number.isFinite(speed) || speed < 0))) return json({ error: 'invalid_fix' }, 400);
  const fix = JSON.stringify({ timestamp, coords: { latitude, longitude, accuracy, speed } });
  // An older arrival can acknowledge successfully but cannot overwrite a newer fix.
  const result = await db.prepare('UPDATE gps_links SET fix=CASE WHEN fix_time<? THEN ? ELSE fix END, fix_time=MAX(fix_time,?) WHERE id=? AND writer=? AND expires_at>?')
    .bind(timestamp, fix, timestamp, id, key, now).run();
  return result.meta.changes ? json({ received: true }) : missing();
}
