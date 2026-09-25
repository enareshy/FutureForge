// Extension points for standards whose real parser is not bundled (§3, §10-12, §17).
//
// These adapters are honest: they register the format, expose capabilities,
// detection and an explicit extension point, but refuse import/export/validate
// with ADAPTER_UNAVAILABLE until a compliant library is installed and the
// adapter is registered in its place.
import { StandardsExchangeAdapter } from "./base.js";

export class PlannedAdapter extends StandardsExchangeAdapter {
  constructor(descriptor) {
    super(descriptor);
    this.extensionPoint = descriptor.extension_point || null;
  }

  getExtensionPoint() {
    return this.extensionPoint;
  }

  getCapabilities() {
    return { ...super.getCapabilities(), extension_point: true, adapter_status: this.status };
  }

  detect(payload, { fileName = "", mimeType = "" } = {}) {
    const text = typeof payload === "string" ? payload : Buffer.isBuffer(payload) ? payload.toString("utf8", 0, 256) : "";
    for (const extension of this._formats.flatMap((format) => format.extensions || [])) {
      if (extension && String(fileName).toLowerCase().endsWith(String(extension).toLowerCase())) {
        return { matched: true, confidence: 0.7, reason: "file extension (adapter planned)", format_code: this._formats[0]?.code };
      }
    }
    for (const mime of this._formats.flatMap((format) => format.mime_types || [])) {
      if (mime && String(mimeType).toLowerCase() === String(mime).toLowerCase()) {
        return { matched: true, confidence: 0.6, reason: "mime type (adapter planned)", format_code: this._formats[0]?.code };
      }
    }
    if (this.code === "step-ap242" && /^ISO-10303-21;/.test(text)) {
      return { matched: true, confidence: 0.95, reason: "STEP Part 21 header", format_code: this._formats[0]?.code };
    }
    if (this.code === "pdfa" && text.startsWith("%PDF-")) {
      return { matched: true, confidence: 0.9, reason: "PDF header", format_code: this._formats[0]?.code };
    }
    if (this.code === "jt" && text.startsWith("Version")) {
      return { matched: true, confidence: 0.6, reason: "JT header heuristic", format_code: this._formats[0]?.code };
    }
    return { matched: false, confidence: 0, reason: "not matched" };
  }
}

const STEP_FORMAT = {
  code: "STEP_AP242",
  name: "STEP AP242",
  standard_name: "ISO 10303-242",
  standard_version: "AP242",
  category: "CAD",
  mime_types: ["model/step", "application/step", "application/octet-stream"],
  extensions: [".stp", ".step", ".p21"],
  adapter_code: "step-ap242",
};

const JT_FORMAT = {
  code: "JT",
  name: "JT",
  standard_name: "ISO 14306 JT",
  standard_version: "ISO 14306",
  category: "CAD",
  mime_types: ["model/jt", "application/octet-stream"],
  extensions: [".jt"],
  adapter_code: "jt",
};

const PDFA_FORMAT = {
  code: "PDF_A",
  name: "PDF/A",
  standard_name: "ISO 19005 PDF/A",
  standard_version: "PDF/A",
  category: "DOCUMENT",
  mime_types: ["application/pdf"],
  extensions: [".pdf"],
  adapter_code: "pdfa",
};

const CAD_FORMAT = {
  code: "CAD_EXCHANGE",
  name: "CAD exchange",
  standard_name: "FutureForge CAD exchange",
  standard_version: "1.0",
  category: "CAD",
  mime_types: ["application/octet-stream"],
  extensions: [],
  adapter_code: "cad",
};

export class StepAp242Adapter extends PlannedAdapter {
  constructor() {
    super({
      code: "step-ap242",
      name: "STEP AP242 adapter",
      category: "CAD",
      provider: "external",
      status: "PLANNED",
      description: "ISO 10303-242 adapter. Install a compliant STEP parser and register an AVAILABLE adapter with this code.",
      capabilities: { parse: false, serialize: false, schema: "STEP_SCHEMA", geometry: true, pmr: true },
      formats: [STEP_FORMAT],
      extension_point: {
        interface: "StandardsExchangeAdapter",
        required_methods: ["import", "export", "validate"],
        suggested_libraries: ["stepcode", "Open Cascade", "pythonOCC", "jsDAV"],
        mapping_notes: "Map STEP product/part/geometry entities to canonical objects, and assembly structure to canonical relationships.",
      },
    });
  }
}

export class JtAdapter extends PlannedAdapter {
  constructor() {
    super({
      code: "jt",
      name: "JT adapter",
      category: "CAD",
      provider: "external",
      status: "PLANNED",
      description: "ISO 14306 JT adapter. Install a supported JT library and register an AVAILABLE adapter.",
      capabilities: { parse: false, serialize: false, schema: "JT_SCHEMA", geometry: true, visualization: true },
      formats: [JT_FORMAT],
      extension_point: {
        interface: "StandardsExchangeAdapter",
        required_methods: ["import", "export", "validate"],
        suggested_libraries: ["JT Open Toolkit", "Siemens JT", "vismockup"],
        mapping_notes: "Extract LOD/geometry references and part metadata into canonical objects.",
      },
    });
  }
}

export class PdfAAdapter extends PlannedAdapter {
  constructor() {
    super({
      code: "pdfa",
      name: "PDF/A adapter",
      category: "DOCUMENT",
      provider: "external",
      status: "UNSUPPORTED",
      description: "PDF/A metadata extraction and compliance validation via File/Content Management. No bundled PDF engine.",
      capabilities: { parse: false, serialize: false, metadata: true, compliance: true, integration: "file" },
      formats: [PDFA_FORMAT],
      extension_point: {
        interface: "StandardsExchangeAdapter",
        required_methods: ["validate", "import"],
        suggested_libraries: ["veraPDF", "Apache PDFBox", "pdf-lib"],
        mapping_notes: "Validate compliance, then attach the file through File/Content Management and map PDF metadata to canonical metadata.",
      },
    });
  }
}

export class CadExchangeAdapter extends PlannedAdapter {
  constructor() {
    super({
      code: "cad",
      name: "CAD exchange adapter",
      category: "CAD",
      provider: "platform",
      status: "PLANNED",
      description: "Generic CAD exchange dispatcher. Delegates to a concrete CAD adapter (STEP/JT) selected by detected content.",
      capabilities: { parse: false, serialize: false, dispatch: true, integration: "pdm" },
      formats: [CAD_FORMAT],
      extension_point: {
        interface: "StandardsExchangeAdapter",
        required_methods: ["detect", "import", "export"],
        suggested_libraries: [],
        mapping_notes: "Dispatch to step-ap242 or jt once available; link geometry to PDM CAD associations.",
      },
    });
  }
}

export { STEP_FORMAT, JT_FORMAT, PDFA_FORMAT, CAD_FORMAT };
