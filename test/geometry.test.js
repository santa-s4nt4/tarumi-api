import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute, riverNormal, xy } from '../src/geometry.js';
import { predict } from '../src/predict.js';

test('projects onto a segment and interpolates distance and historical time', () => {
 const m=matchRoute([[0,0,0,10],[0,100,100,30]],[5,25]);
 assert.equal(m.offset,5); assert.equal(m.s,25); assert.equal(m.t,15);
});
test('river sign is geographic east/west, independent of travel direction', () => {
 for(const nodes of [[[0,0,0,0],[0,100,100,10]],[[0,100,0,0],[0,0,100,10]]]) {
  const m=matchRoute(nodes,[0,50]);
  assert.equal(riverNormal(nodes,[[20,0],[20,100]],m).signedDistanceMeters,20);
  assert.equal(riverNormal(nodes,[[-30,0],[-30,100]],m).signedDistanceMeters,-30);
 }
});
test('selects nearest of multiple river intersections and does not extend river segments', () => {
 const nodes=[[0,0,0,0],[0,100,100,10]],m=matchRoute(nodes,[0,50]);
 assert.equal(riverNormal(nodes,[[20,0],[20,100],[-5,100],[-5,0]],m).signedDistanceMeters,-5);
 assert.equal(riverNormal(nodes,[[20,60],[20,100]],m).status,'no_intersection');
});
test('north/south-only intersection has no invented east/west sign', () => {
 const nodes=[[0,0,0,0],[100,0,100,10]],m=matchRoute(nodes,[50,0]);
 const r=riverNormal(nodes,[[0,30],[100,30]],m);
 assert.equal(r.distanceMeters,30);assert.equal(r.signedDistanceMeters,null);
});
test('duplicate GPS coordinates do not divide by zero', () => {
 assert.equal(matchRoute([[0,0,0,0],[0,0,0,3],[0,100,100,13]],[0,50]).t,8);
});
test('prediction filters passed events, includes tunnel exit, rejects off-route GPS', () => {
 const p=xy(35.57,136.64);
 const dataset={direction:'front',nodes:[[...p,0,0],[0,100,100,20]],river:[[20,0],[20,100]],tunnels:[{id:'t1',start:0,end:80}],events:[{id:'past',type:'station',s:0,t:0},{id:'exit',type:'tunnel',s:80,t:16}],coverage:{}};
 const result=predict(dataset,{latitude:35.57045,longitude:136.64});
 assert.equal(result.position.inTunnel,true);assert.equal(result.upcoming.length,1);
 assert.ok(Math.abs(result.upcoming[0].distanceMeters-30)<1);
 assert.ok(Math.abs(result.upcoming[0].etaSeconds-6)<0.2);
 assert.equal(result.next.station,null);
 assert.equal(predict(dataset,{latitude:36,longitude:136}),null);
});

import { stationStop, speedAt } from '../src/motion.js';
test('station target is beginning of dwell, held at zero until departure', () => {
 const nodes=[];
 for(let t=0;t<=40;t++) { const y=t<10?t*10:t<=30?100:100+(t-30)*10;nodes.push([0,y,y,t]); }
 const station={lat:35.57+100/111195.0802335329,lon:136.64};
 const stop=stationStop(nodes,station,{s:100});
 assert.ok(stop.t<15);assert.ok(stop.departureT>25);
 assert.equal(speedAt(nodes,20),0);assert.equal(speedAt(nodes,5),10);
 const d={nodes,events:[{id:'s',type:'station',target:'arrival',...stop}],tunnels:[],river:[]};
 const result=predict(d,{latitude:station.lat,longitude:station.lon});
 assert.equal(result.next.station.etaSeconds,0);
 assert.equal(result.next.station.arrived,true);
});
