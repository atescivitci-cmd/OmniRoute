import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoutingTransportAttempt,runWithRoutingTransportAttempt,runWithRoutingTransportWire,getRoutingTransportOutcome,assertRoutingTransportDispatch,bindRoutingTransportResponse,getCurrentRoutingTransportFailure} from '../../open-sse/services/routingTransportContext.ts';

test('network cause survives refusal without allowing another send',async()=>{
 const token=createRoutingTransportAttempt();
 const cause=Object.assign(new Error('secret URL'),{code:'ECONNRESET',errno:-54,syscall:'read'});
 const original=new TypeError('fetch failed',{cause});
 let thrown;
 await assert.rejects(runWithRoutingTransportAttempt(token,()=>runWithRoutingTransportWire(()=>{assertRoutingTransportDispatch('wire');throw original;})),e=>{thrown=e;return e.execution==='unknown';});
 const out=getRoutingTransportOutcome(token);
 assert.deepEqual(out.transportFailure,{name:'TypeError',causeName:'Error',causeCode:'ECONNRESET',causeErrno:-54,causeSyscall:'read'});
 assert.deepEqual(thrown.transportFailure,out.transportFailure);
 assert.equal(out.modelDispatches,1);assert.equal(out.wireDispatches,1);assert.equal(out.uncertain,true);
 await assert.rejects(runWithRoutingTransportAttempt(token,()=>42));
});
test('guard refusal is not misreported as an original network error',async()=>{
 const token=createRoutingTransportAttempt();
 await assert.rejects(runWithRoutingTransportAttempt(token,()=>runWithRoutingTransportWire(()=>{assertRoutingTransportDispatch('wire');assertRoutingTransportDispatch('wire');})),e=>e.code==='routing_transport_replay_blocked');
 const out=getRoutingTransportOutcome(token);assert.equal(out.blocked,true);assert.equal(out.wireDispatches,1);assert.equal(out.transportFailure,undefined);
});
test('messages URLs headers stacks and unknown codes cannot enter diagnostics',async()=>{
 const token=createRoutingTransportAttempt();const secret='DO_NOT_PERSIST_SECRET';
 const e=Object.assign(new Error(secret),{code:secret,syscall:secret,errno:secret,headers:{Authorization:secret},cause:{name:secret,code:secret,message:secret}});
 await assert.rejects(runWithRoutingTransportAttempt(token,()=>runWithRoutingTransportWire(()=>{throw e;})));
 assert.deepEqual(getRoutingTransportOutcome(token).transportFailure,{name:'Error'});
 assert.ok(!JSON.stringify(getRoutingTransportOutcome(token)).includes(secret));
});
test('throwing getters cannot hide the authoritative uncertain outcome',async()=>{
 const token=createRoutingTransportAttempt();const e=new Error('private');
 for(const key of ['name','code','cause','errno','syscall'])Object.defineProperty(e,key,{get(){throw Error('getter ran');}});
 await assert.rejects(runWithRoutingTransportAttempt(token,()=>runWithRoutingTransportWire(()=>{throw e;})),e=>e.code==='routing_transport_execution_uncertain');
 assert.deepEqual(getRoutingTransportOutcome(token).transportFailure,{name:'Error'});
});
test('abort remains cancelled and uncertain with a bounded diagnostic',async()=>{
 const c=new AbortController(),token=createRoutingTransportAttempt({signal:c.signal});
 await assert.rejects(runWithRoutingTransportAttempt(token,()=>runWithRoutingTransportWire(()=>{c.abort();throw new DOMException('private','AbortError');})),e=>e.status===499);
 const out=getRoutingTransportOutcome(token);assert.equal(out.cancelled,true);assert.equal(out.uncertain,true);assert.equal(out.transportFailure.name,'AbortError');
});
test('diagnostic snapshots are immutable and cannot mutate private state',async()=>{
 const token=createRoutingTransportAttempt();await assert.rejects(runWithRoutingTransportAttempt(token,()=>runWithRoutingTransportWire(()=>{throw Object.assign(new Error('private'),{code:'UND_ERR_CONNECT_TIMEOUT'});})));const out=getRoutingTransportOutcome(token);
 assert.equal(out.transportFailure.code,'UND_ERR_CONNECT_TIMEOUT');assert.throws(()=>{out.transportFailure.code='ECONNRESET';},TypeError);assert.equal(getRoutingTransportOutcome(token).transportFailure.code,'UND_ERR_CONNECT_TIMEOUT');
});
test('late response-body errors retain safe codes after async context exits',async()=>{
 const token=createRoutingTransportAttempt();
 let streamController;
 const response=await runWithRoutingTransportAttempt(token,()=>runWithRoutingTransportWire(()=>bindRoutingTransportResponse(new Response(new ReadableStream({start(c){streamController=c;}})),token)));
 streamController.error(Object.assign(new Error('secret body URL'),{code:'UND_ERR_SOCKET'}));
 await assert.rejects(response.text());
 const out=getRoutingTransportOutcome(token);assert.equal(out.uncertain,true);assert.equal(out.transportFailure.code,'UND_ERR_SOCKET');assert.equal(getCurrentRoutingTransportFailure(),undefined);
});
test('trusted diagnostic getter is scoped to its owning attempt',async()=>{
 const token=createRoutingTransportAttempt();
 await runWithRoutingTransportAttempt(token,async()=>{try{await runWithRoutingTransportWire(()=>{throw Object.assign(new Error('secret'),{code:'ECONNREFUSED'});});}catch{assert.equal(getCurrentRoutingTransportFailure().code,'ECONNREFUSED');}}).catch(()=>{});
 assert.equal(getCurrentRoutingTransportFailure(),undefined);
});
