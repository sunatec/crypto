import assert from 'node:assert/strict';
export const componentFields=['id','segmentId','realStartTime','realEndTime','realStartTicks','realEndTicks','actualLowTicks','actualHighTicks','actualLowTime','actualHighTime','analysisStartTime','analysisEndTime','analysisStartTicks','analysisEndTicks','direction','confirmedAt','ruleId','dependencies','ordinal'];

// Check declared ownership and independent expectations, never infer segments.
export function validateNormalizationSnapshots(fixture,{fields,time,integer,string,strings,list}){
  const items=fixture.input.items;
  for(let i=1;i<items.length;i++){
    assert(items[i].startTime===items[i-1].endTime && items[i].startTicks===items[i-1].endTicks && items[i].direction!==items[i-1].direction,'normalization stroke continuity');
  }
  list(fixture.expected);assert.equal(fixture.expected.length,items.length,'every prefix needs a snapshot');
  const locked=new Map(),eventIds=new Set(),eventObjects=new Set();
  for(const [index,snapshot] of fixture.expected.entries()){
    fields(snapshot,['prefix','state','structures','events','reason']);
    assert.equal(snapshot.prefix,index+1);string(snapshot.reason);
    fields(snapshot.state,['normalizedCount']);integer(snapshot.state.normalizedCount);
    list(snapshot.structures);list(snapshot.events);
    assert.equal(snapshot.state.normalizedCount,snapshot.structures.length,'normalized count mismatch');
    const current=new Map();
    for(const [position,record] of snapshot.structures.entries()){
      fields(record,componentFields);
      for(const key of componentFields.filter(k=>k.endsWith('Time') || k==='confirmedAt'))time(record[key]);
      for(const key of componentFields.filter(k=>k.endsWith('Ticks') || k==='ordinal'))integer(record[key]);
      assert.equal(record.ordinal,position+1,'component order');
      assert.equal(record.segmentId,`${fixture.id}/S/${position+1}/${record.realStartTime}`,'source segment binding');
      assert.equal(record.id,`${fixture.id}/N/${position+1}/${record.realStartTime}`,'component identity');
      assert.equal(record.ruleId,'N-001/E-008');strings(record.dependencies);
      assert.deepEqual(record.dependencies,[record.segmentId],'component source dependency');
      assert(['up','down'].includes(record.direction));
      assert(record.realStartTime<record.realEndTime && record.realEndTime<=record.confirmedAt && record.confirmedAt<=items[index].completedAt,'component confirmation time');
      assert(record.actualLowTicks<record.actualHighTicks && Math.min(record.realStartTicks,record.realEndTicks)>=record.actualLowTicks && Math.max(record.realStartTicks,record.realEndTicks)<=record.actualHighTicks,'component range');
      assert.equal(record.analysisStartTime,record.realStartTime,'analysis start anchor');
      assert.equal(record.analysisEndTime,record.realEndTime,'analysis end anchor');
      assert.equal(record.analysisStartTicks,record.direction==='up'?record.actualLowTicks:record.actualHighTicks,'analysis start price');
      assert.equal(record.analysisEndTicks,record.direction==='up'?record.actualHighTicks:record.actualLowTicks,'analysis end price');
      const owned=items.slice(0,index+1).filter(p=>p.startTime>=record.realStartTime && p.endTime<=record.realEndTime);
      assert(owned.length>0 && owned[0].startTime===record.realStartTime && owned.at(-1).endTime===record.realEndTime,'component ownership span');
      assert.equal(owned[0].startTicks,record.realStartTicks);assert.equal(owned.at(-1).endTicks,record.realEndTicks);
      const points=[{time:owned[0].startTime,value:owned[0].startTicks},...owned.map(p=>({time:p.endTime,value:p.endTicks}))];
      for(const point of points)assert(point.value>=record.actualLowTicks && point.value<=record.actualHighTicks,'component member bounds');
      for(const side of ['Low','High']){
        const witness=points.find(p=>p.value===record[`actual${side}Ticks`]);
        assert(witness && witness.time===record[`actual${side}Time`],'component extreme witness or earliest source');
      }
      if(position>0){const prior=snapshot.structures[position-1];assert(prior.realEndTime===record.realStartTime && prior.realEndTicks===record.realStartTicks && prior.direction!==record.direction && prior.confirmedAt<=record.confirmedAt,'component real continuity');}
      if(locked.has(record.id))assert.deepEqual(record,locked.get(record.id),'confirmed component changed');
      else locked.set(record.id,record);
      assert(!current.has(record.id),'duplicate component');current.set(record.id,record);
    }
    for(const id of locked.keys())assert(current.has(id),'confirmed component disappeared');
    for(const event of snapshot.events){
      fields(event,['id','type','objectId','occurredAt','confirmedAt']);string(event.id);
      assert(!eventIds.has(event.id) && !eventObjects.has(event.objectId),'duplicate normalization event');
      const record=current.get(event.objectId);assert(record,'unbound normalization event');
      assert.equal(event.type,'normalized');assert.equal(event.occurredAt,record.analysisEndTime);assert.equal(event.confirmedAt,record.confirmedAt);
      assert.equal(event.confirmedAt,items[index].completedAt,'normalization event wrong prefix');
      eventIds.add(event.id);eventObjects.add(event.objectId);
    }
    for(const id of locked.keys())assert(eventObjects.has(id),'component needs a confirmation event');
  }
}
