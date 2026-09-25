// Provider-independent adapter abstraction (§3).
//
// Every standard implements this contract. New standards are added by
// registering an adapter subclass, never by editing the exchange engine.
import { adapterUnavailable } from "../errors.js";

export class StandardsExchangeAdapter {
  constructor(descriptor = {}) {
    this.code = descriptor.code;
    this.name = descriptor.name || descriptor.code;
    this.category = descriptor.category || "OTHER";
    this.provider = descriptor.provider || "platform";
    this.library = descriptor.library || "";
    this.status = descriptor.status || "AVAILABLE";
    this.description = descriptor.description || "";
    this._capabilities = descriptor.capabilities || {};
    this._formats = descriptor.formats || [];
  }

  getFormat() {
    return this._formats[0] || { code: this.code, name: this.name, adapter_code: this.code };
  }

  getSupportedVersions() {
    return this._formats.map((format) => format.standard_version).filter(Boolean);
  }

  getCapabilities() {
    return { ...this._capabilities };
  }

  getSchema() {
    return {};
  }

  isAvailable() {
    return this.status === "AVAILABLE";
  }

  assertAvailable(operation) {
    if (!this.isAvailable()) {
      throw adapterUnavailable(this.code, this.status, `Adapter ${this.code} cannot ${operation}: status is ${this.status}`);
    }
  }

  // Returns { matched, confidence, reason, format_code }.
  detect() {
    return { matched: false, confidence: 0, reason: "not implemented" };
  }

  // Returns an ordered list of ValidationResult records (§9). Adapters that
  // cannot validate throw adapterUnavailable.
  validate() {
    this.assertAvailable("validate");
    return [];
  }

  // Returns { document, errors, warnings } where document is canonical.
  import() {
    this.assertAvailable("import");
    throw adapterUnavailable(this.code, this.status, `Adapter ${this.code} does not implement import`);
  }

  // Returns { payload, mime_type, file_name, errors, warnings }.
  export() {
    this.assertAvailable("export");
    throw adapterUnavailable(this.code, this.status, `Adapter ${this.code} does not implement export`);
  }
}

export class AdapterRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(adapter) {
    if (!adapter || !adapter.code) throw new Error("An adapter with a code is required");
    this.adapters.set(adapter.code, adapter);
    return adapter;
  }

  unregister(code) {
    return this.adapters.delete(code);
  }

  get(code) {
    return this.adapters.get(code) || null;
  }

  has(code) {
    return this.adapters.has(code);
  }

  list() {
    return [...this.adapters.values()];
  }

  reset() {
    this.adapters.clear();
  }
}

export const adapters = new AdapterRegistry();

export function registerAdapter(adapter) {
  return adapters.register(adapter);
}

export function getAdapter(code) {
  return adapters.get(code);
}

export function listAdapters() {
  return adapters.list();
}
