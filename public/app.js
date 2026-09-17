const form = document.querySelector("#oracle-form");
const requestInput = document.querySelector("#request");
const charCount = document.querySelector("#char-count");
const submitBtn = document.querySelector("#submit-btn");
const statusBox = document.querySelector("#status");
const result = document.querySelector("#result");
const answerOutput = document.querySelector("#answer-output");
const domainBadge = document.querySelector("#domain-badge");
const qaBadge = document.querySelector("#qa-badge");
const copyBtn = document.querySelector("#copy-btn");
const routeTask = document.querySelector("#route-task");
const routeGoal = document.querySelector("#route-goal");
const routeComplexity = document.querySelector("#route-complexity");
const routeQa = document.querySelector("#route-qa");

requestInput.addEventListener("input", () => { charCount.textContent = `${requestInput.value.length.toLocaleString()} / 12,000`; });
function setStatus(message, type = "") { statusBox.textContent = message; statusBox.className = `status ${type}`.trim(); }
function hideStatus() { statusBox.className = "status hidden"; }

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const request = requestInput.value.trim();
  if (!request) return;
  submitBtn.disabled = true;
  result.classList.add("hidden");
  setStatus("Oracle is planning, routing, executing, and checking your work…");
  try {
    const response = await fetch("/api/oracle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Oracle Stack failed.");
    answerOutput.textContent = data.answer;
    domainBadge.textContent = `${data.route.domain} specialist`;
    qaBadge.textContent = data.qa.pass ? "QA passed" : "QA flagged";
    qaBadge.className = `badge ${data.qa.pass ? "good" : "warn"}`;
    routeTask.textContent = data.route.task || "—";
    routeGoal.textContent = data.route.goal || "—";
    routeComplexity.textContent = `${data.route.depth || "normal"} · ${data.route.complexity || "standard"}`;
    const repairs = [];
    if (data.qa.planRepaired) repairs.push("planning repaired automatically");
    if (data.qa.answerRepaired) repairs.push("final answer repaired automatically");
    routeQa.textContent = data.qa.pass ? (repairs.length ? `Passed after ${repairs.join(" and ")}.` : "Planning and final-answer QA passed.") : (data.qa.issues?.join(" ") || "Oracle still has QA concerns.");
    hideStatus();
    result.classList.remove("hidden");
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setStatus(error.message || "Something went wrong.", "error");
  } finally { submitBtn.disabled = false; }
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(answerOutput.textContent);
    copyBtn.textContent = "Copied";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
  } catch { copyBtn.textContent = "Copy failed"; }
});
