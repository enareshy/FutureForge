// Server-side masking engine. Masking is the only sanctioned way to expose a
// protected field: it happens before serialization, never in the client.
import { createHash } from "node:crypto";
import { assertionError } from "./errors.js";
import { MASKING_STRATEGIES } from "./constants.js";

const customHandlers = new Map();

export function registerMaskingHandler(name, handler) {
  if (!name || typeof handler !== "function") {
    throw assertionError("A masking handler name and function are required");
  }
  customHandlers.set(String(name), handler);
  return [...customHandlers.keys()];
}

export function listMaskingStrategies() {
  return MASKING_STRATEGIES.map((strategy) => ({
    strategy,
    description: MASKING_DESCRIPTIONS[strategy],
  }));
}

const MASKING_DESCRIPTIONS = {
  HIDE: "Remove the field from the response entirely",
  NULL: "Replace the value with null",
  PARTIAL: "Reveal only configured leading and trailing characters",
  REDACT: "Replace the value with a redaction marker",
  HASH: "Replace the value with a salted hash",
  FIXED_MASK: "Replace the value with a fixed mask",
  CUSTOM: "Delegate to a registered masking handler",
};

function partial(value, config) {
  const text = String(value ?? "");
  const start = Math.max(0, Number(config.visible_start ?? config.prefix ?? 0));
  const end = Math.max(0, Number(config.visible_end ?? config.suffix ?? 0));
  const maskChar = String(config.mask_char ?? "*").slice(0, 1) || "*";
  if (text.length <= start + end) return maskChar.repeat(Math.max(text.length, 1));
  const head = text.slice(0, start);
  const tail = end ? text.slice(text.length - end) : "";
  return `${head}${maskChar.repeat(text.length - start - end)}${tail}`;
}

function resolveStrategy(strategy) {
  const normalized = String(strategy || "").toUpperCase();
  if (!MASKING_STRATEGIES.includes(normalized)) {
    throw assertionError(`Unknown masking strategy "${strategy}"`);
  }
  return normalized;
}

export function applyMasking(strategy, value, config = {}, context = {}) {
  const resolved = resolveStrategy(strategy);
  const cfg = config && typeof config === "object" ? config : {};
  switch (resolved) {
    case "HIDE":
      return { value: undefined, hidden: true, strategy: resolved };
    case "NULL":
      return { value: null, hidden: false, strategy: resolved };
    case "PARTIAL":
      return { value: partial(value, cfg), hidden: false, strategy: resolved };
    case "REDACT":
      return {
        value: String(cfg.replacement ?? cfg.value ?? "REDACTED"),
        hidden: false,
        strategy: resolved,
      };
    case "HASH": {
      const salt = String(cfg.salt ?? context.salt ?? "");
      const algorithm = String(cfg.algorithm ?? "sha256");
      const encoding = String(cfg.encoding ?? "hex");
      const length = Number(cfg.length ?? 0);
      let digest;
      try {
        digest = createHash(algorithm).update(`${salt}${value ?? ""}`).digest(encoding);
      } catch {
        digest = createHash("sha256").update(`${salt}${value ?? ""}`).digest("hex");
      }
      return {
        value: length > 0 ? digest.slice(0, length) : digest,
        hidden: false,
        strategy: resolved,
      };
    }
    case "FIXED_MASK":
      return {
        value: String(cfg.mask ?? cfg.value ?? "******"),
        hidden: false,
        strategy: resolved,
      };
    case "CUSTOM": {
      const handlerName = String(cfg.handler ?? "");
      const handler = customHandlers.get(handlerName);
      if (!handler) {
        return {
          value: String(cfg.replacement ?? cfg.value ?? "REDACTED"),
          hidden: false,
          strategy: resolved,
        };
      }
      return { value: handler(value, cfg, context), hidden: false, strategy: resolved };
    }
    default:
      return { value, hidden: false, strategy: resolved };
  }
}

export function maskRecord(record, ruleMap, context = {}) {
  if (!record || typeof record !== "object") return record;
  const output = Array.isArray(record) ? [...record] : { ...record };
  for (const [field, decision] of ruleMap.entries()) {
    if (!(field in output)) continue;
    if (decision.effect === "hide" || decision.strategy === "HIDE") {
      delete output[field];
      continue;
    }
    if (decision.effect === "deny") {
      delete output[field];
      continue;
    }
    if (decision.effect === "mask") {
      const masked = applyMasking(decision.strategy, output[field], decision.config, context);
      if (masked.hidden) delete output[field];
      else output[field] = masked.value;
    }
  }
  return output;
}
