// @ts-nocheck
import assert from "node:assert/strict";
import {test} from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),"nvidia-pair-fixture-"));
const child=path.join(path.dirname(fileURLToPath(import.meta.url)),"fixtures/nvidia-pair-probe.ts");
function run(mode,dir){
 const x=spawnSync(process.execPath,["--import","tsx",child,mode],{cwd:process.cwd(),env:{...process.env,DATA_DIR:dir,HOME:dir,NODE_ENV:"test",DISABLE_SQLITE_AUTO_BACKUP:"true"},encoding:"utf8",timeout:30000});
 assert.equal(x.status,0,x.stderr.slice(-1200));const line=x.stdout.split("\n").find(x=>x.startsWith("PAIR_RESULT:"));assert.ok(line);return JSON.parse(line.slice(12));
}
test("named combo excludes only a current negative, on next selection and after actual process restart",()=>{
 const dir=scratch(),first=run("seed",dir);const after=run("read",dir);
 for(const x of [first,after]){
  assert.equal(x.stored,true);assert.equal(x.locked,true);
  assert.deepEqual(x.pairs,["fixture-a:healthy/model","fixture-b:healthy/model","fixture-b:moonshotai/kimi-k2.6"]);
 }
});
test("an ambiguous upstream error mentioning the short phrase must not authorize fallback",async()=>{
 const {isNvidiaAccountFunctionMissing}=await import("../../src/lib/db/nvidiaModelAvailabilityPolicy.ts");
 for(const msg of ['worker failed after generation; function not found for this account; billing uncertain',JSON.stringify({status:503,detail:'function not found for this account'}),JSON.stringify({status:404,detail:'resource not found',untrusted:'function not found for this account'})])
  assert.equal(isNvidiaAccountFunctionMissing("nvidia",404,msg),false);
});
test("an unrelated catalog addition cannot release an existing model/account quarantine",()=>{
 const dir=scratch();run("seed",dir);const x=run("churn",dir);
 assert.equal(x.stored,true);assert.equal(x.locked,true);
 assert.ok(!x.pairs.includes("fixture-a:moonshotai/kimi-k2.6"));
});
test("a current legacy record upgrades without granting access; a stale one is not fabricated as current",()=>{
 const dir=scratch();run("seed",dir);assert.equal(run("legacy",dir).stored,true);
 assert.equal(run("churn",dir).stored,true);
 assert.equal(run("staleLegacy",dir).stored,false);
});
test("elapsed time and an unrelated connection success never reinstate the excluded pair",()=>{
 const dir=scratch();run("seed",dir);const later=run("oldNegative",dir);
 assert.equal(later.stored,true);assert.ok(!later.pairs.includes("fixture-a:moonshotai/kimi-k2.6"));
});
test("generation or usage alongside an entitlement-looking error is not proof of zero side effects",async()=>{
 const {isNvidiaAccountFunctionMissing}=await import("../../src/lib/db/nvidiaModelAvailabilityPolicy.ts");
 const detail="Function 'fixture-fn': Not found for account 'fixture-acct'";
 for(const body of [{status:404,detail,usage:{completion_tokens:9}},{status:404,detail,choices:[{text:"partial"}]}]){
  assert.equal(isNvidiaAccountFunctionMissing("nvidia",404,JSON.stringify(body)),false);
 }
});
test("untrusted NVIDIA wire codes and uncertain status do not authorize the next executor",async()=>{
 const {createRoutingAttemptGuard}=await import("../../open-sse/services/combo/routingAttemptSafety.ts");
 for(const [status,code] of [[401,"model_not_found"],[403,"nvidia_model_catalog_negative"],[404,"model_not_found"],[408,"timeout"],[503,"upstream_unavailable"]]){
  let calls=0;const b={messages:[{role:"user",content:"fixture"}]};
  const guard=createRoutingAttemptGuard({body:b,limit:2});
  const run=guard.wrap(async (_b,_m,t)=>{calls++;t.routingAttemptToken.enter();return Response.json({error:{code}},{status});});
  await run(b,"nvidia/model-a",{provider:"nvidia",connectionId:"a"});
  await run(b,"nvidia/model-b",{provider:"nvidia",connectionId:"b"});
  assert.equal(calls,1,"untrusted "+status+" must not advance");
 }
});
test("native evidence must bind the actual error, account, model and native endpoint",async()=>{
 const {isNativeNvidiaEntitlementRejection: check}=await import("../../open-sse/services/modelEligibilityResponse.ts");
 const endpoint="https://integrate.api.nvidia.com/v1/chat/completions",detail="Function 'fixture-fn': Not found for account 'fixture-acct'";
 const evidence={provider:"nvidia",nativeExecutor:true,status:404,endpoint,responseUrl:endpoint,redirected:false,body:{status:404,title:"Not Found",detail},expectedModel:"m",attemptModel:"m",expectedConnection:"a",attemptConnection:"a"};
 assert.equal(check(evidence),true);
 for(const change of [{endpoint:"https://example.invalid/v1/chat/completions"},{nativeExecutor:false},{redirected:true},{responseUrl:"https://example.invalid/"},{status:403},{attemptModel:"x"},{attemptConnection:"b"},{expectedConnection:""},{body:{error:{message:detail},usage:{completion_tokens:2}}}]){
  assert.equal(check({...evidence,...change}),false);
 }
});
