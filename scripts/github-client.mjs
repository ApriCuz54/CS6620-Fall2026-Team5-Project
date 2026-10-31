import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

function fail(message) {
   console.error(message);
   process.exit(1);
}

const {
   SCANNER_URL,
   SCANNER_TOKEN,
   REPOSITORY,
   PR_NUMBER,
   BASE_SHA,
   HEAD_SHA,
} = process.env;

for (const [name, value] of Object.entries({
   SCANNER_URL,
   SCANNER_TOKEN,
   REPOSITORY,
   PR_NUMBER,
   BASE_SHA,
   HEAD_SHA,
})) {
   if (!value)
      fail(
         `${name} is not set; the scan cannot run, so this PR is not approved.`,
      );
}

const git = (...args) => promisify(execFile)("git", args).then((r) => r.stdout);

const changedFiles = (
   await git(
      "diff",
      "--name-only",
      "--diff-filter=d",
      `${BASE_SHA}...${HEAD_SHA}`,
   )
)
   .split("\n")
   .filter(Boolean);

const jsFiles = changedFiles.filter(
   (file) =>
      file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs"),
);

if (jsFiles.length === 0) {
   fail("No JavaScript files changed in this PR; nothing was scanned.");
}

console.log(`Scanning ${jsFiles.length} file(s):\n  ${jsFiles.join("\n  ")}`);

const files = [];
for (const path of jsFiles) {
   files.push({ path, content: await git("show", `${HEAD_SHA}:${path}`) });
}

const authHeader = { Authorization: `Bearer ${SCANNER_TOKEN}` };
const HTTP_TIMEOUT = 30 * 1000;

const submitRes = await fetch(new URL("/v1/jobs", SCANNER_URL), {
   method: "POST",
   headers: { ...authHeader, "Content-Type": "application/json" },
   body: JSON.stringify({
      schemaVersion: "1",
      repository: REPOSITORY,
      pullRequest: Number(PR_NUMBER),
      commitSha: HEAD_SHA,
      simulation: "clean",
      files,
   }),
   signal: AbortSignal.timeout(HTTP_TIMEOUT),
});

let job = await submitRes.json().catch(() => ({}));
if (!submitRes.ok) {
   fail(`Submit failed: HTTP ${submitRes.status} ${job.error?.code ?? ""}`);
}
console.log(
   `Job ${job.jobId}: ${job.status}${job.reused ? " (reused existing job)" : ""}`,
);

// polling starts
const TIME_CAP = 15 * 60 * 1000;
const POLL_INTERVAL = 5 * 1000;
const startTime = Date.now();

while (job.status !== "COMPLETED" && job.status !== "FAILED") {
   if (Date.now() - startTime > TIME_CAP) {
      fail(
         `Scan did not finish within ${TIME_CAP / 60000} minutes; not approved.`,
      );
   }
   await sleep(POLL_INTERVAL);

   const pollRes = await fetch(new URL(job.statusUrl, SCANNER_URL), {
      headers: authHeader,
      signal: AbortSignal.timeout(HTTP_TIMEOUT),
   });
   job = await pollRes.json().catch(() => ({}));
   if (!pollRes.ok) {
      fail(
         `Status check failed: HTTP ${pollRes.status} ${job.error?.code ?? ""}`,
      );
   }
   console.log(`Job ${job.jobId}: ${job.status}`);
}

if (job.status === "FAILED") {
   fail(`Scan failed: ${job.error?.code ?? "unknown error"}`);
}

console.log(
   `Findings: ${job.summary.high} high, ${job.summary.medium} medium, ${job.summary.low} low`,
);

if (
   job.commitSha?.toLowerCase() !== HEAD_SHA.toLowerCase() ||
   job.pullRequest !== Number(PR_NUMBER)
) {
   fail("Scanner returned a result for a different commit or PR; refusing it.");
}

if (job.mode === "dummy" || job.mergeAllowed !== true) {
   fail(
      `Result is not a real security verdict (mode=${job.mode}); merge not approved.`,
   );
}

console.log("Security gate passed.");
