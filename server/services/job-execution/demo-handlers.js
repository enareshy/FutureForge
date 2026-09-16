// Development/demo handlers.
//
// The execution engine ships with no business logic. These handlers exist only
// so the engine, scheduling, retry, timeout, cancellation, progress and
// dead-letter behaviour can be exercised end-to-end in development and tests.
// Real capability handlers are registered by the owning business modules, and
// production deployments may leave these unregistered.

import { registerHandler } from "./handlers.js";
import { JobError } from "./errors.js";

const DEFAULT_STEPS = [
  { name: "preparing", duration_ms: 15 },
  { name: "processing", duration_ms: 25 },
  { name: "finalizing", duration_ms: 10 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Cooperative sleep: wakes up frequently to observe cancellation/timeout.
async function interruptibleSleep(ms, context) {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    context.checkCancelled();
    await sleep(Math.min(100, Math.max(1, end - Date.now())));
  }
}

async function simulate(context, defaults = {}) {
  const input = context.input || {};
  const steps = Array.isArray(input.steps) && input.steps.length ? input.steps : defaults.steps || DEFAULT_STEPS;
  const total = steps.length;
  const loop = Math.max(1, Number(input.loop) || 1);

  let index = 0;
  for (let iteration = 1; iteration <= loop; iteration += 1) {
    for (const step of steps) {
      context.checkCancelled();
      const stage = loop > 1 ? `${step.name}_${iteration}` : step.name;
      context.step(stage, { progress: Math.round((index / total) * 100), message: `${stage} started` });
      if (step.duration_ms) await interruptibleSleep(step.duration_ms, context);
      if (step.fail) {
        throw new JobError(step.message || `Simulated failure in ${stage}`, {
          category: step.category || "temporary",
          code: step.code || "simulated_failure",
          step: stage,
        });
      }
      index += 1;
      context.reportProgress({
        progress: Math.round((index / total) * 100),
        stage,
        processed: index,
        total,
        message: `${stage} complete`,
      });
    }
  }

  if (input.fail) {
    const failure = typeof input.fail === "object" ? input.fail : {};
    throw new JobError(failure.message || "Simulated failure", {
      category: failure.category || "temporary",
      code: failure.code || "simulated_failure",
    });
  }

  const artifacts = input.artifacts || defaults.artifacts || [
    {
      kind: "output",
      name: `${context.job_ref}-result.json`,
      filename: `${context.job_ref}.json`,
      content_type: "application/json",
      size: 256,
    },
  ];

  return {
    message: input.message || `${context.job_type_code} completed`,
    result: { job_ref: context.job_ref, steps: total, loop, ...(input.result || {}) },
    artifacts,
    last_step: steps[steps.length - 1]?.name || "",
  };
}

const DEMO_HANDLERS = [
  ["jobs.bulkImport", "Simulated bulk data import"],
  ["jobs.cadProcessing", "Simulated CAD conversion/processing"],
  ["jobs.bomValidation", "Simulated BOM validation"],
  ["jobs.reportGeneration", "Simulated report generation"],
  ["jobs.dataSync", "Simulated data synchronisation"],
  ["jobs.searchIndexing", "Simulated search indexing"],
  ["jobs.workflowExecution", "Simulated workflow execution"],
  ["jobs.integrationSync", "Simulated integration sync"],
];

export function registerDemoHandlers() {
  for (const [code, description] of DEMO_HANDLERS) {
    registerHandler(code, (context) => simulate(context), { description });
  }
  registerHandler("JOBS.DEMO", (context) => simulate(context), { description: "Generic engine demo handler" });
  return DEMO_HANDLERS.map(([code]) => code);
}

export { simulate };
