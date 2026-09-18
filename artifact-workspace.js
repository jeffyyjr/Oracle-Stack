import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { storageEnabled, saveArtifactBundle } from "./storage.js";

const ROOT = process.env.ORACLE_WORKSPACE_DIR || "/tmp/oracle-workspaces";
const ARCHIVE_ROOT = process.env.ORACLE_ARTIFACT_ARCHIVE_DIR || path.join(process.cwd(), "oracle-artifacts");
const MAX_FILES = 30;
const MAX_BYTES = 250000;
const RUN_TIMEOUT_MS = 30000;

function safeName(v="artifact") { return String(v).toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,80) || "artifact"; }
function safeRel(v="") {
  const n=path.posix.normalize(String(v).replace(/\\/g,"/")).replace(/^\.\.\//g,"");
  if (!n || n.startsWith("/") || n.includes("../")) throw new Error("unsafe artifact path");
  return n;
}
function run(cmd,args,cwd){
  return new Promise(resolve=>{
    const p=spawn(cmd,args,{cwd,env:{...process.env,CI:"1"},stdio:["ignore","pipe","pipe"]});
    let out="",err=""; const timer=setTimeout(()=>p.kill("SIGKILL"),RUN_TIMEOUT_MS);
    p.stdout.on("data",d=>out+=d); p.stderr.on("data",d=>err+=d);
    p.on("close",code=>{clearTimeout(timer);resolve({command:[cmd,...args].join(" "),code,stdout:out.slice(-12000),stderr:err.slice(-12000)});});
    p.on("error",e=>{clearTimeout(timer);resolve({command:[cmd,...args].join(" "),code:null,stdout:out,stderr:String(e.message)});});
  });
}

export async function materializeExecutionArtifacts({ opportunity="work", files=[], testCommands=[] }={}) {
  if (!Array.isArray(files) || files.length===0) return {status:"NO_ARTIFACTS",files:[],tests:[]};
  if (files.length>MAX_FILES) throw new Error("artifact file limit exceeded");
  const id=`${Date.now()}-${crypto.randomUUID().slice(0,8)}-${safeName(opportunity)}`;
  const dir=path.join(ROOT,id); await fs.mkdir(dir,{recursive:true});
  let bytes=0, written=[];
  const durableFiles=[];
  for (const f of files) {
    const rel=safeRel(f.path), body=String(f.content ?? "");
    bytes+=Buffer.byteLength(body); if(bytes>MAX_BYTES) throw new Error("artifact byte limit exceeded");
    const target=path.join(dir,rel); await fs.mkdir(path.dirname(target),{recursive:true}); await fs.writeFile(target,body,"utf8"); written.push(rel); durableFiles.push({path:rel,content:body});
  }
  const allowed=(Array.isArray(testCommands)?testCommands:[]).slice(0,6).filter(x=>Array.isArray(x)&&["node","npm","python3"].includes(x[0]));
  const tests=[]; for(const c of allowed) tests.push(await run(c[0],c.slice(1),dir));
  const status=tests.some(t=>t.code!==0)?"QA_FAILED":"MATERIALIZED";
  let archive=null;
  if(status==="MATERIALIZED"){
    const archiveDir=path.join(ARCHIVE_ROOT,id);
    await fs.mkdir(archiveDir,{recursive:true});
    await fs.cp(dir,archiveDir,{recursive:true});
    const manifest={workspace:id,opportunity:safeName(opportunity),createdAt:new Date().toISOString(),files:written,tests};
    await fs.writeFile(path.join(archiveDir,"oracle-manifest.json"),JSON.stringify(manifest,null,2),"utf8");
    archive=archiveDir;
    if(storageEnabled()) {
      const manifest={workspace:id,opportunity:safeName(opportunity),createdAt:new Date().toISOString(),files:written,tests};
      await saveArtifactBundle({workspaceId:id,opportunity:safeName(opportunity),status,manifest,files:durableFiles,tests});
    }
  }
  return {status,workspace:id,archive,postgresPersisted:status==="MATERIALIZED"&&storageEnabled(),files:written,tests};
}
