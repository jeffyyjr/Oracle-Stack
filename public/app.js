const form=document.querySelector("#oracle-form"),input=document.querySelector("#request"),count=document.querySelector("#char-count"),submit=document.querySelector("#submit-btn"),messages=document.querySelector("#messages"),statusBox=document.querySelector("#status"),details=document.querySelector("#route-details"),keyInput=document.querySelector("#oracle-key"),saveKeyBtn=document.querySelector("#save-oracle-key"),clearKeyBtn=document.querySelector("#clear-oracle-key"),keyState=document.querySelector("#oracle-key-state");
const history=[];
const KEY_STORAGE="oracleApiKey";
function readKey(){try{return localStorage.getItem(KEY_STORAGE)||"";}catch{return "";}}
function writeKey(value){try{if(value)localStorage.setItem(KEY_STORAGE,value);else localStorage.removeItem(KEY_STORAGE);}catch{}}
function refreshKeyState(){const key=readKey();if(keyInput)keyInput.value=key;if(keyState)keyState.textContent=key?"Access key connected.":"No access key connected.";}
refreshKeyState();
saveKeyBtn?.addEventListener("click",()=>{const key=String(keyInput?.value||"").trim();if(!key){status("Paste an Oracle access key first.","error");return;}writeKey(key);refreshKeyState();status("Oracle access key saved on this device.","success");});
clearKeyBtn?.addEventListener("click",()=>{writeKey("");refreshKeyState();status("Oracle access key removed from this device.");});
input.addEventListener("input",()=>{count.textContent=`${input.value.length.toLocaleString()} / 12,000`;});
input.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();form.requestSubmit();}});
document.querySelector("#new-chat").addEventListener("click",()=>{history.length=0;[...messages.querySelectorAll(".user-message,.dynamic-oracle")].forEach(x=>x.remove());details.classList.add("hidden");input.value="";count.textContent="0 / 12,000";input.focus();});
function status(msg,type=""){statusBox.textContent=msg;statusBox.className=`status ${type}`.trim();}
function hideStatus(){statusBox.className="status hidden";}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}
function addMessage(role,text){const row=document.createElement("div");row.className=`message ${role==="user"?"user-message":"oracle-message dynamic-oracle"}`;row.innerHTML=role==="user"?`<div class="bubble"><p>${escapeHtml(text)}</p></div><div class="avatar user-avatar">You</div>`:`<div class="avatar">O</div><div class="bubble"><strong>Oracle</strong><pre>${escapeHtml(text)}</pre></div>`;messages.appendChild(row);row.scrollIntoView({behavior:"smooth",block:"end"});}
function contextRequest(latest){if(!history.length)return latest;const prior=history.slice(-8).map(x=>`${x.role.toUpperCase()}: ${x.text}`).join("\n\n");return `You are continuing a conversation with the user. Use prior turns only as context; execute the newest user message.\n\nPRIOR CONVERSATION:\n${prior}\n\nNEW USER MESSAGE:\n${latest}`;}
async function parseResponse(r){const raw=await r.text();try{return raw?JSON.parse(raw):{};}catch{throw new Error(`Oracle returned HTTP ${r.status}.`);}}
async function callOracle(request){
  const apiKey=readKey();
  if(!apiKey){const e=new Error("Oracle access key is not connected. Open the API page, activate beta access, then come back here.");e.status=401;throw e;}
  let last;
  for(let i=0;i<2;i++){
    try{
      const r=await fetch("/api/oracle",{method:"POST",headers:{"Content-Type":"application/json","x-oracle-key":apiKey},body:JSON.stringify({request}),cache:"no-store"});
      const d=await parseResponse(r);
      if(!r.ok){const e=new Error(d.error||`Oracle failed with HTTP ${r.status}.`);e.status=r.status;throw e;}
      return d;
    }catch(e){
      last=e;
      if(e.status===401){if(/invalid/i.test(e.message||"")){writeKey("");refreshKeyState();e.message="Oracle access key is invalid or expired. Activate a fresh key on the API page."; }break;}
      if(e.status&&![408,425,429,500,502,503,504].includes(e.status))break;
      if(i===0)await new Promise(r=>setTimeout(r,900));
    }
  }
  throw last;
}
form.addEventListener("submit",async e=>{e.preventDefault();const text=input.value.trim();if(!text)return;addMessage("user",text);input.value="";count.textContent="0 / 12,000";submit.disabled=true;status("Oracle is deciding which agents and execution path to use…");try{const data=await callOracle(contextRequest(text));const answer=data.answer||"Oracle completed the run but returned no answer text.";history.push({role:"user",text},{role:"oracle",text:answer});if(history.length>16)history.splice(0,history.length-16);addMessage("oracle",answer);document.querySelector("#route-domain").textContent=data.route?.domain||"general";document.querySelector("#route-task").textContent=data.route?.task||"—";document.querySelector("#route-goal").textContent=data.route?.goal||"—";document.querySelector("#route-complexity").textContent=`${data.route?.depth||"normal"} · ${data.route?.complexity||"standard"}`;document.querySelector("#route-model").textContent=data.model?`${data.model.provider} · ${data.model.name}`:"—";document.querySelector("#route-qa").textContent=data.qa?.pass?"QA passed":"QA flagged";details.classList.remove("hidden");hideStatus();}catch(err){status(err.message||"Oracle hit an error. Try again.","error");}finally{submit.disabled=false;input.focus();}});
