import { stationStop } from '../src/motion.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { xy, distance, matchRoute, lineIntersection, sub, lerp, latLon } from '../src/geometry.js';

const read = name => fs.readFileSync(new URL('../data/' + name, import.meta.url), 'utf8').replace(/^\uFEFF/, '');
// These supplied CSVs contain unquoted scalar fields; reject quoting rather than silently misparse.
function csv(name) {
  const text = read(name);
  if (text.includes('"')) throw new Error(`${name}: quoted CSV needs a CSV parser`);
  const [header, ...lines] = text.trim().split(/\r?\n/).map(l => l.split(','));
  return lines.map(values => Object.fromEntries(header.map((k, i) => [k, values[i]])));
}
const stations = JSON.parse(read('stations.json'));
const tunnels = csv('tarumi_tunnels.csv');
const river = csv('neo_river_points.csv').sort((a,b) => +a.sequence - +b.sequence).map(p => xy(+p.latitude, +p.longitude));
const bundles = [];
for (const direction of ['front', 'back']) {
  const source = JSON.parse(read(`gps-${direction}.json`));
  let s = 0;
  const nodes = source.records.map((r, i, all) => {
    if (![r.lat, r.lon, r.t].every(Number.isFinite) || Math.abs(r.lat) > 90 || Math.abs(r.lon) > 180 || (i && r.t <= all[i - 1].t)) throw new Error('Invalid GPS record');
    const p = xy(r.lat, r.lon);
    if (i) s += distance(xy(all[i - 1].lat, all[i - 1].lon), p);
    return [...p, s, r.t, Number.isFinite(r.speed) && r.speed >= 0 ? r.speed : null];
  });
  const excluded = [], events = [], intervals = [];
  function project(lat, lon, id) {
    const m = matchRoute(nodes, xy(+lat, +lon));
    // Avoid projecting places outside the recorded extent onto its endpoints.
    if (m.offset > 100 || ((m.s < 1 || m.s > s - 1) && m.offset > 30)) { excluded.push(id); return null; }
    return m;
  }
  for (const station of stations.stations) {
    const id = `station-${station.order}`;
    const m = project(station.lat, station.lon, id);
    if (m) {
      const stop = stationStop(nodes, station, m);
      events.push({ id, type: 'station', name: station.name, target: stop ? 'arrival' : 'station_point', s: m.s, t: m.t, ...stop, location: { latitude: station.lat, longitude: station.lon }, matchOffsetMeters: m.offset });
    }
  }
  for (const tunnel of tunnels) {
    const id = `tunnel-${tunnel.osm_way_id}`;
    const a = project(tunnel.entry_latitude, tunnel.entry_longitude, `${id}-a`);
    const b = project(tunnel.exit_latitude, tunnel.exit_longitude, `${id}-b`);
    if (!a || !b) continue;
    const [entry, exit] = [a, b].sort((x,y) => x.s - y.s);
    const name = tunnel.tunnel_name || `トンネル${tunnel.sequence}`;
    intervals.push({ id, name, start: entry.s, end: exit.s });
    for (const [target, m] of [['entrance',entry],['exit',exit]]) events.push({ id: `${id}-${target}`, featureId: id, type:'tunnel', name, target, s:m.s, t:m.t, location:latLon(m.point), matchOffsetMeters:m.offset });
  }
  const crossings = [];
  for (let i=1;i<nodes.length;i++) {
    const a=nodes[i-1], b=nodes[i];
    if (distance(a,b)<0.001) continue;
    for (let j=1;j<river.length;j++) {
      const hit=lineIntersection(a,sub(b,a),river[j-1],river[j]);
      if (!hit || hit.t < 0 || hit.t > 1) continue;
      crossings.push({s:lerp(a[2],b[2],hit.t),t:lerp(a[3],b[3],hit.t),location:latLon(hit.point)});
    }
  }
  crossings.sort((a,b)=>a.s-b.s);
  let last=-Infinity;
  for (const c of crossings) {
    if(c.s-last<30) continue; // duplicate intersections near segment boundaries / GPS jitter
    last=c.s;
    events.push({id:`river-${direction}-${events.filter(e=>e.type==='river').length+1}`,type:'river',name:'根尾川',target:'centerline_crossing',...c});
  }
  events.sort((a,b)=>a.s-b.s);
  const bundle={ direction, label:source.label, nodes, river, events, tunnels:intervals, excluded,
    coverage:{start:latLon(nodes[0]),end:latLon(nodes.at(-1)),distanceMeters:s,sourceStartSeconds:nodes[0][3],sourceEndSeconds:nodes.at(-1)[3]},
    attribution:stations.attribution + '; 川・トンネル: supplied OpenStreetMap-derived data',
  };
  bundles.push(bundle);
  console.log(direction,JSON.stringify({points:nodes.length,stations:events.filter(e=>e.type==='station').map(e=>e.name),tunnels:intervals.length,riverCrossings:events.filter(e=>e.type==='river').length,excluded}));
}
const version=crypto.createHash('sha256').update(JSON.stringify(bundles)).digest('hex').slice(0,16);
const quote=s=>"'"+s.replaceAll("'","''")+"'";
// D1 limits SQL statement size; split the JSON into small rows (also below row limits).
const statements=['CREATE TABLE IF NOT EXISTS route_dataset_chunks (direction TEXT NOT NULL, part INTEGER NOT NULL, version TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(direction,part));'];
for (const bundle of bundles) {
  statements.push(`DELETE FROM route_dataset_chunks WHERE direction=${quote(bundle.direction)};`);
  const payload=JSON.stringify(bundle);
  for(let offset=0,part=0;offset<payload.length;offset+=16000,part++) {
    statements.push(`INSERT INTO route_dataset_chunks VALUES (${quote(bundle.direction)},${part},${quote(version)},${quote(payload.slice(offset,offset+16000))});`);
  }
}
const sql=`-- Generated by npm run data:build; source version ${version}\n`+statements.join('\n')+'\n';
fs.mkdirSync(new URL('../generated/',import.meta.url),{recursive:true});
fs.writeFileSync(new URL('../generated/routes.sql',import.meta.url),sql);
