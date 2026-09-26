import { HttpError } from "../../validation.js";

// Virus scanning provider interface. The built-in scanner is a deterministic
// heuristic used for development and tests; production deployments register a
// real engine (ClamAV, cloud scanner) through `registerScanProvider` without
// changing the Document module.

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export const SCAN_STATUSES = ["clean", "infected", "failed", "skipped"];

export class HeuristicScanProvider {
  constructor({ name = "heuristic" } = {}) {
    this.name = name;
  }

  async scan({ buffer, size = 0, mimeType = "", extension = "" }) {
    const text = buffer ? buffer.toString("latin1") : "";
    if (text.includes(EICAR)) {
      return { status: "infected", engine: this.name, signature: "EICAR-Test-File", detail: "Known test signature" };
    }
    if (size === 0) {
      return { status: "failed", engine: this.name, signature: "", detail: "Empty payload" };
    }
    if (mimeType === "application/x-msdownload" || extension === "exe" || extension === "scr") {
      return { status: "infected", engine: this.name, signature: "Executable-Disallowed", detail: "Executable payloads are not permitted" };
    }
    return { status: "clean", engine: this.name, signature: "", detail: "" };
  }
}

export class NoopScanProvider {
  constructor({ name = "noop" } = {}) {
    this.name = name;
  }

  async scan() {
    return { status: "skipped", engine: this.name, signature: "", detail: "Scanning disabled" };
  }
}

const providers = new Map();
providers.set("heuristic", new HeuristicScanProvider());
providers.set("noop", new NoopScanProvider());

export function registerScanProvider(name, provider) {
  if (!name || !provider?.scan) throw new HttpError(400, "A scan provider requires a name and a scan() method");
  providers.set(name, provider);
  return provider;
}

export function resolveScanProvider(name) {
  const resolved = name || process.env.FILE_SCAN_PROVIDER || "heuristic";
  const provider = providers.get(resolved);
  if (!provider) throw new HttpError(500, `Unknown scan provider: ${resolved}`);
  return provider;
}

export function scanProviderNames() {
  return [...providers.keys()];
}
