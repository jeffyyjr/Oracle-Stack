import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { storageEnabled, saveArtifactBundle } from "./storage.js";

const ROOT=process.env.ORACLE_WORKSPACE_DIR||"/tmp/oracle-workspaces";
const ARCHIVE_ROOT=process.env.ORACLE_ARTIFACT_ARCHIVE_DIR||path.join(process.cwd(),"oracle-artifacts");
const MAX_FILES=30,MAX_BYTES=250000,RUN_TIMEOUT_MS=30000;

function safeName(v="artifact"){return String(v).toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,80)||"artifact";}
function safeRel(v=""){const n=path.posix.normalize(String(v).replace(/\\/g,"/")).replace(/^\.\.\//g,"");if(!n||n.startsWith("/")||n.includes("../"))throw new Error("unsafe artifact path");return n;}
function run(cmd,args,cwd){return new Promise(resolve=>{const p=spawn(cmd,args,{cwd,env:{...process.env,CI:"1"},stdio:["ignore","pipe","pipe"]});let out="",err="";const timer=setTimeout(()=>p.kill("SIGKILL"),RUN_TIMEOUT_MS);p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);p.on("close",code=>{clearTimeout(timer);resolve({command:[cmd,...args].join(" "),code,stdout:out.slice(-12000),stderr:err.slice(-12000)});});p.on("error",e=>{clearTimeout(timer);resolve({command:[cmd,...args].join(" "),code:null,stdout:out,stderr:String(e.message)});});});}
async function runTests(commands,dir){const allowed=(Array.isArray(commands)?commands:[]).slice(0,6).filter(x=>Array.isArray(x)&&["node","npm","python3"].includes(x[0]));const tests=[];for(const c of allowed)tests.push(await run(c[0],c.slice(1),dir));return tests;}
async function snapshot(dir,written){const files=[];for(const rel of written)files.push({path:rel,content:await fs.readFile(path.join(dir,rel),"utf8")});return files;}

export async function applyArtifactRepairs({workspace,files=[]}={}){
  if(!workspace||!Array.isArray(files)||!files.length)throw new Error("repair files required");
  const dir=path.join(ROOT,safeName(workspace));
  let bytes=0,written=[];
  for(const f of files){const rel=safeRel(f.path),body=String(f.content??"");bytes+=Buffer.byteLength(body);if(bytes>MAX_BYTES)throw new Error("repair byte limit exceeded");const target=path.join(dir,rel);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,body,"utf8");written.push(rel);}
  return {workspace,changedFiles:written};
}

export async function rerunArtifactTests({workspace,testCommands=[]}={}){
  const dir=path.join(ROOT,safeName(workspace));
  const tests=await runTests(testCommands,dir);
  return {status:tests.some(t=>t.code!==0)?"QA_FAILED":"MATERIALIZED",workspace,tests};
}

export async function finalizeArtifact({workspace,opportunity="work",status,files=[],tests=[],repairAttempts=0}={}){
  if(status!=="MATERIALIZED")return {status,workspace,postgresPersisted:false,files,tests,repairAttempts};
  const dir=path.join(ROOT,safeName(workspace)),archiveDir=path.join(ARCHIVE_ROOT,safeName(workspace));
  await fs.mkdir(archiveDir,{recursive:true});await fs.cp(dir,archiveDir,{recursive:true});
  const durableFiles=await snapshot(dir,files);
  const manifest={workspace,opportunity:safeName(opportunity),createdAt:new Date().toISOString(),files,tests,repairAttempts};
  await fs.writeFile(path.join(archiveDir,"oracle-manifest.json"),JSON.stringify(manifest,null,2),"utf8");
  if(storageEnabled())await saveArtifactBundle({workspaceId:workspace,opportunity:safeName(opportunity),status,manifest,files:durableFiles,tests});
  return {status,workspace,archive:archiveDir,postgresPersisted:storageEnabled(),files,tests,repairAttempts};
}

export async function materializeExecutionArtifacts({opportunity="work",files=[],testCommands=[]}={}){
  if(!Array.isArray(files)||files.length===0)return {status:"NO_ARTIFACTS",files:[],tests:[]};
  if(files.length>MAX_FILES)throw new Error("artifact file limit exceeded");
  const id=`${Date.now()}-${crypto.randomUUID().slice(0,8)}-${safeName(opportunity)}`,dir=path.join(ROOT,id);
  await fs.mkdir(dir,{recursive:true});let bytes=0,written=[];
  for(const f of files){const rel=safeRel(f.path),body=String(f.content??"");bytes+=Buffer.byteLength(body);if(bytes>MAX_BYTES)throw new Error("artifact byte limit exceeded");const target=path.join(dir,rel);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,body,"utf8");written.push(rel);}
  const tests=await runTests(testCommands,dir),status=tests.some(t=>t.code!==0)?"QA_FAILED":"MATERIALIZED";
  if(status==="MATERIALIZED")return finalizeArtifact({workspace:id,opportunity,status,files:written,tests,repairAttempts:0});
  return {status,workspace:id,archive:null,postgresPersisted:false,files:written,tests,repairAttempts:0};
}
