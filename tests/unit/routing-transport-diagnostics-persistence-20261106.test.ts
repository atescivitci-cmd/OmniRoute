import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),"omni-transport-diagnostic-"));
process.env.DATA_DIR=dataDir;
const {persistAttemptLogs}=await import("../../open-sse/handlers/chatCore/attemptLogging.ts");
const {getCallLogById}=await import("../../src/lib/usage/callLogs.ts");
const core=await import("../../src/lib/db/core.ts");
const {createRoutingTransportAttempt,runWithRoutingTransportAttempt,runWithRoutingTransportWire}=await import("../../open-sse/services/routingTransportContext.ts");
test.after(()=>{core.resetDbInstance();fs.rmSync(dataDir,{recursive:true,force:true,maxRetries:3});});
function context(id:string,noLogEnabled=false){return {traceId:id,provider:"example",connectionId:"conn",model:"example-model",skillRequestId:id,detailedLoggingEnabled:false,reqLogger:null,pendingRequestId:id,clientRawRequest:{endpoint:"/v1/chat/completions"},requestedModel:"example-model",credentials:{connectionId:"conn"},startTime:Date.now(),body:{messages:[{role:"user",content:"offline fixture"}],_omniroute:{routingTransportFailure:{code:"SPOOFED_SECRET"},other:"preserved"}},sourceFormat:"openai",targetFormat:"openai",comboName:"offline-diagnostics",comboStepId:null,comboExecutionKey:null,tokensCompressed:0,apiKeyInfo:null,noLogEnabled};}
async function row(id:string){for(let n=0;n<100;n++){const value=await getCallLogById(id);if(value)return value as any;await new Promise(r=>setTimeout(r,10));}throw Error("temporary call log not persisted");}
test("actual healthy persistence removes spoofed diagnostics without mutating caller",async()=>{
 await core.ensureDbInitialized();const ctx=context("diagnostic-healthy");
 persistAttemptLogs({status:200,responseBody:{choices:[]}},ctx);const actual=await row(ctx.traceId);
 assert.equal(actual.requestBody._omniroute.routingTransportFailure,undefined);assert.equal(actual.requestBody._omniroute.other,"preserved");assert.equal(ctx.body._omniroute.routingTransportFailure.code,"SPOOFED_SECRET");
});
test("actual failed persistence replaces spoof with trusted sanitized diagnostic",async()=>{
 await core.ensureDbInitialized();const ctx=context("diagnostic-failed"),token=createRoutingTransportAttempt();
 await assert.rejects(runWithRoutingTransportAttempt(token,async()=>{try{await runWithRoutingTransportWire(()=>{throw Object.assign(new Error("PRIVATE_SECRET"),{code:"ECONNRESET"});});}catch{persistAttemptLogs({status:503,error:"transport stopped"},ctx);}}));
 const actual=await row(ctx.traceId);assert.deepEqual(actual.requestBody._omniroute.routingTransportFailure,{name:"Error",code:"ECONNRESET"});assert.ok(!JSON.stringify(actual.requestBody).includes("SPOOFED_SECRET"));assert.ok(!JSON.stringify(actual.requestBody).includes("PRIVATE_SECRET"));
});
test("noLog continues to suppress the entire request diagnostic payload",async()=>{
 await core.ensureDbInitialized();const ctx=context("diagnostic-nolog",true);persistAttemptLogs({status:503,error:"transport stopped"},ctx);assert.equal((await row(ctx.traceId)).requestBody,null);
});
