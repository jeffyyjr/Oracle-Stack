const form = document.querySelector("#oracle-form");
const requestInput = document.querySelector("#request");
const charCount = document.querySelector("#char-count");
const submitBtn = document.querySelector("#submit-btn");
const statusBox = document.querySelector("#status");
const result = document.querySelector("#result");
const originalOutput = document.querySelector("#original-output");
const upgradedOutput = document.querySelector("#upgraded-output");
const domainBadge = document.querySelector("#domain-badge");
const qaBadge = document.querySelector("#qa-badge");
const copyBtn = document.querySelector("#copy-btn");
const routeTask = document.querySelector("#route-task");
const routeGoal = document.querySelector("#route-goal");
const routeComplexity = document.querySelector("#route-complexity");
const routeQa = document.querySelector("#route-qa");

requestInput.addEventListener("input", () => {
  charCount.textContent = `${requestInput.value.length.toLocaleString()} / 12,000`;
});

function setStatus(message, type = "") {
  statusBox.textContent = message;
  statusBox.className = `status ${type}`.trim();
}

function hideStatus() {
  statusBox.className = "status hidden";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const request = requestInput.value.trim();
  if (!request) return;

  submitBtn.disabled = true;
  result.classList.add("hidden");
  setStatus("Oracle is reading your intent, routing it, and running Judge/QA…");

  try {
    const response = await fetch("/api/oracle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Oracle Stack failed.");
    }

    originalOutput.textContent = data.original;
    upgradedOutput.textContent = data.upgraded;

    domainBadge.textContent = `${data.route.domain} specialist`;

    qaBadge.textContent = data.qa.pass ? "Judge passed" : "Judge flagged";
    qaBadge.className = `badge ${data.qa.pass ? "good" : "warn"}`;

    routeTask.textContent = data.route.task || "—";
    routeGoal.textContent = data.route.goal || "—";
    routeComplexity.textContent = data.route.complexity || "—";

    if (data.qa.pass && data.qa.repaired) {
      routeQa.textContent = "Judge found an issue, Oracle repaired it automatically, and the second check passed.";
    } else if (data.qa.pass) {
      routeQa.textContent = "Passed on the first QA check.";
    } else {
      routeQa.textContent = data.qa.issues?.length
        ? data.qa.issues.join(" ")
        : "Judge still has concerns after the repair pass.";
    }

    hideStatus();
    result.classList.remove("hidden");
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setStatus(error.message || "Something went wrong.", "error");
  } finally {
    submitBtn.disabled = false;
  }
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(upgradedOutput.textContent);
    const originalLabel = copyBtn.textContent;
    copyBtn.textContent = "Copied";
    setTimeout(() => {
      copyBtn.textContent = originalLabel;
    }, 1200);
  } catch {
    copyBtn.textContent = "Copy failed";
  }
});
