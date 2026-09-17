const form = document.querySelector("#oracle-form");
const requestInput = document.querySelector("#request");
const charCount = document.querySelector("#char-count");
const submitBtn = document.querySelector("#submit-btn");
const statusBox = document.querySelector("#status");
const result = document.querySelector("#result");
const answerOutput = document.querySelector("#answer-output");
const domainBadge = document.querySelector("#domain-badge");
const modelBadge = document.querySelector("#model-badge");
const qaBadge = document.querySelector("#qa-badge");
const copyBtn = document.querySelector("#copy-btn");
const routeTask = document.querySelector("#route-task");
const routeGoal = document.querySelector("#route-goal");
const routeComplexity = document.querySelector("#route-complexity");
const routeModel = document.querySelector("#route-model");
const routeReason = document.querySelector("#route-reason");
const routeQa = document.querySelector("#route-qa");
const feedbackStatus = document.querySelector("#feedback-status");
const feedbackButtons = [...document.querySelectorAll(".feedback-btn")];
let currentExecutionId = "";

requestInput.addEventListener("input", () => { charCount.textContent = `${requestInput.value.length.toLocaleString()} / 12,000`; });
function setStatus(message, type = "") { statusBox.textContent = message; statusBox.className = `status ${type}`.trim(); }
function hideStatus() { statusBox.className = "status hidden"; }
function resetFeedback() {
  feedbackStatus.textContent = "";
  feedbackButtons.forEach(button => { button.disabled = false; });
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function parseResponse(response) {
  const raw = await response.text();
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch {
    if (!response.ok) throw new Error(`Oracle returned HTTP ${response.status}. Please try again.`);
    throw new Error("Oracle returned an unreadable response. Please try again.");
  }
}

async function callOracle(request) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch("/api/oracle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request }),
        cache: "no-store"
      });
      const data = await parseResponse(response);
      if (!response.ok) {
        const message = data.error || `Oracle Stack failed with HTTP ${response.status}.`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      lastError = error;
      const transient = !error.status || [408, 425, 429, 500, 502, 503, 504].includes(error.status);
      if (!transient || attempt === 2) break;
      setStatus("Oracle hit a temporary connection problem. Retrying once…");
      await sleep(900);
    }
  }
  throw lastError || new Error("Oracle Stack failed.");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const request = requestInput.value.trim();
  if (!request) return;
  submitBtn.disabled = true;
  result.classList.add("hidden");
  currentExecutionId = "";
  resetFeedback();
  setStatus("Oracle is routing, executing, and checking your work…");
  try {
    const data = await callOracle(request);
    currentExecutionId = data.telemetry?.executionId || "";
    answerOutput.textContent = data.answer || "Oracle completed the request but returned no answer text.";
    domainBadge.textContent = `${data.route?.domain || "general"} specialist`;
    modelBadge.textContent = data.model?.name || data.telemetry?.model || "auto model";
    const qaPassed = Boolean(data.qa?.pass);
    qaBadge.textContent = qaPassed ? "QA passed" : "QA flagged";
    qaBadge.className = `badge ${qaPassed ? "good" : "warn"}`;
    routeTask.textContent = data.route?.task || "—";
    routeGoal.textContent = data.route?.goal || "—";
    routeComplexity.textContent = `${data.route?.depth || "normal"} · ${data.route?.complexity || "standard"}`;
    routeModel.textContent = data.model ? `${data.model.provider} · ${data.model.name}` : "—";
    routeReason.textContent = data.telemetry?.routingReason ? `${data.telemetry.routingReason}${data.telemetry.routingScore != null ? ` · score ${data.telemetry.routingScore}` : ""}` : "Oracle selected automatically";
    const repairs = [];
    if (data.qa?.planRepaired) repairs.push("planning repaired automatically");
    if (data.qa?.answerRepaired) repairs.push("final answer repaired automatically");
    routeQa.textContent = qaPassed ? (repairs.length ? `Passed after ${repairs.join(" and ")}.` : "Final-answer QA passed.") : (data.qa?.issues?.join(" ") || "Oracle still has QA concerns.");
    hideStatus();
    result.classList.remove("hidden");
    try { result.scrollIntoView({ behavior: "smooth", block: "start" }); } catch { result.scrollIntoView(); }
  } catch (error) {
    const message = error?.message && !/expected pattern/i.test(error.message)
      ? error.message
      : "Oracle hit a temporary browser or network error. Please try again.";
    setStatus(message, "error");
  } finally { submitBtn.disabled = false; }
});

feedbackButtons.forEach(button => {
  button.addEventListener("click", async () => {
    if (!currentExecutionId) return;
    const score = Number(button.dataset.score);
    feedbackButtons.forEach(item => { item.disabled = true; });
    feedbackStatus.textContent = "Saving…";
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ executionId: currentExecutionId, score })
      });
      const data = await parseResponse(response);
      if (!response.ok) throw new Error(data.error || "Feedback failed.");
      feedbackStatus.textContent = `Saved ${score}/5 — Oracle will use it for routing.`;
    } catch (error) {
      feedbackStatus.textContent = error.message || "Feedback failed.";
      feedbackButtons.forEach(item => { item.disabled = false; });
    }
  });
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(answerOutput.textContent);
    copyBtn.textContent = "Copied";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
  } catch { copyBtn.textContent = "Copy failed"; }
});
