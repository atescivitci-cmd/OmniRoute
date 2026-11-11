// @ts-nocheck
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const dir=process.env.DATA_DIR;
assert.ok(dir && /^nvidia-pair-fixture-/.test(path.basename(dir)) && fs.statSync(dir).isDirectory());
globalThis.fetch=async()=>{throw new Error("fixture_network_denied")};
const {getDbInstance}=await import("../../../src/lib/db/core.ts");
const {recordNvidiaModelNegative,getNvidiaModelNegative,nvidiaAvailabilityRevision}=await import("../../../src/lib/db/nvidiaModelAvailability.ts");
const {buildAutoCandidates}=await import("../../../open-sse/services/combo.ts");
const {isModelLocked}=await import("../../../open-sse/services/accountFallback.ts");
const db=getDbInstance(),bad="moonshotai/kimi-k2.6",good="healthy/model",a="fixture-a",b="fixture-b";
if(process.argv[2]==="seed"){
 for(const id of [a,b]){
  db.prepare("INSERT INTO provider_connections(id,provider,auth_type,is_active,provider_specific_data,created_at,updated_at,proxy_enabled,per_key_proxy_enabled) VALUES(?,?,?,?,?,?,?,0,0)").run(id,"nvidia","apikey",1,"{}","created","rev1");
  db.prepare("INSERT INTO key_value(namespace,key,value) VALUES(?,?,?)").run("syncedAvailableModels","nvidia:"+id,JSON.stringify([{id:bad},{id:good}]));
 }
 assert.equal(recordNvidiaModelNegative(a,bad,nvidiaAvailabilityRevision("nvidia",a,bad)),true);
}
const targets=[bad,good].map((model,i)=>({kind:"model",provider:"nvidia",modelStr:"nvidia/"+model,stepId:"step"+i,executionKey:"step"+i,connectionId:null,allowedConnectionIds:[a,b]}));
if(process.argv[2]==="churn"){
 db.prepare("UPDATE key_value SET value=? WHERE namespace=? AND key=?").run(JSON.stringify([{id:bad},{id:good},{id:"brand-new/unrelated-model"}]),"syncedAvailableModels","nvidia:"+a);
}
if(["legacy","staleLegacy","oldNegative"].includes(process.argv[2])){
 const k=JSON.stringify([a,bad]),ns="nvidiaAccountModelNegativeV1";
 const row=JSON.parse(db.prepare("SELECT value FROM key_value WHERE namespace=? AND key=?").get(ns,k).value);
 if(process.argv[2]!=="oldNegative")delete row.pairRevision;
 if(process.argv[2]==="staleLegacy")row.revision="0".repeat(64);
 if(process.argv[2]==="oldNegative"){
  const {clearModelLock}=await import("../../../open-sse/services/accountFallback.ts");
  clearModelLock("nvidia",b,bad);row.observedAt="2000-01-01T00:00:00.000Z";
 }
 db.prepare("UPDATE key_value SET value=? WHERE namespace=? AND key=?").run(JSON.stringify(row),ns,k);
}
const pairs=(await buildAutoCandidates(targets,"ac-pressed-zero-token-cost")).map(c=>c.connectionId+":"+c.model).sort();
console.log("PAIR_RESULT:"+JSON.stringify({pairs,stored:!!getNvidiaModelNegative("nvidia",a,bad),locked:isModelLocked("nvidia",a,bad)}));
