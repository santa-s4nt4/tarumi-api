import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from '../src/index.js';
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for(const file of ['0002_gps_links.sql','0003_performance_view.sql']) sqlite.exec(fs.readFileSync('migrations/'+file,'utf8'));
  return { close:()=>sqlite.close(), batch:queries=>Promise.all(queries.map(q=>q.run())), prepare(sql) {
    const statement=sqlite.prepare(sql);
    return { bind(...values) { return { async first() { return statement.get(...values)??null; }, async run() { const result=statement.run(...values); return {meta:{changes:Number(result.changes)}}; } }; } };
  } };
}
async function setup() {
  const db=database();
  const send=(path='',method='GET',token,body)=>worker.fetch(new Request('http://localhost/api/gps-links'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),{DB:db});
  const response=await send('','POST'); assert.equal(response.status,201);
  const link=await response.json(); return {db,send,link,path:'/'+link.id};
}
test('QR scan acknowledges join without starting GPS and restricts credentials', async()=>{
  const {db,send,link,path}=await setup();
  try {
    assert.equal((await send(path+'/join','POST',link.reader)).status,404);
    assert.equal((await send(path+'/join','POST',link.writer)).status,200);
    assert.equal((await send(path,'GET',link.writer)).status,404);
    const state=await(await send(path,'GET',link.reader)).json();
    assert(state.joinedAt>0); assert.equal(state.position,null);
    assert.equal((await send(path+'/join','GET',link.writer)).status,405);
  } finally {db.close();}
});
test('shared train, delay and camera state is validated and ends with its GPS link',async()=>{
  const {db,send,link,path}=await setup();
  try {
    const view={trainId:'23',date:'2026-11-21',delay:120,mode:'bird'};
    assert.equal((await send(path,'PATCH',link.writer,view)).status,404);
    assert.equal((await send(path,'PATCH',link.reader,{...view,delay:-1})).status,400);
    assert.equal((await send(path,'PATCH',link.reader,{...view,mode:'video'})).status,400);
    assert.equal((await send(path,'PATCH',link.reader,view)).status,200);
    assert.deepEqual((await(await send(path,'GET',link.reader)).json()).view,view);
    assert.equal((await send(path,'PATCH',link.reader,{...view,trainId:null,delay:0})).status,200);
    assert.equal((await(await send(path,'GET',link.reader)).json()).view.trainId,null);
    const now=Date.now(); const fix={timestamp:now,latitude:35.5,longitude:136.6,accuracy:5,speed:10};
    assert.equal((await send(path,'PUT',link.writer,fix)).status,200);
    await send(path,'PUT',link.writer,{...fix,timestamp:now-1000});
    assert.equal((await(await send(path,'GET',link.reader)).json()).position.timestamp,now);
    assert.equal((await send(path,'DELETE',link.reader)).status,200);
    assert.equal((await send(path,'GET',link.reader)).status,404);
    assert.equal((await send(path,'PATCH',link.reader,view)).status,404);
  } finally {db.close();}
});
