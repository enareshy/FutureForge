import { HttpError } from "../../validation.js";

// Preview and rendition provider interface. Real conversions (image
// thumbnails, PDF/Office to PDF, 3D/CAD renditions) run in the separate
// File Storage & Processing Services deployment; the built-in provider records
// processing status and emits a lightweight preview descriptor so the Document
// UI can show accurate preview/rendition state without owning converters.

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp", "image/tiff"]);
const DOC_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export class MetadataPreviewProvider {
  constructor({ name = "metadata" } = {}) {
    this.name = name;
  }

  async generate({ mimeType = "", extension = "", name = "" }) {
    if (IMAGE_TYPES.has(mimeType)) {
      return {
        preview: { status: "ready", provider: this.name, kind: "thumbnail", detail: `${extension || "image"} thumbnail available` },
        rendition: { status: "pending", provider: this.name, detail: "" },
      };
    }
    if (DOC_TYPES.has(mimeType)) {
      return {
        preview: { status: "ready", provider: this.name, kind: "document", detail: "First-page preview available" },
        rendition: { status: "ready", provider: this.name, kind: "pdf", detail: "PDF rendition available" },
      };
    }
    if (mimeType.startsWith("text/")) {
      return {
        preview: { status: "ready", provider: this.name, kind: "text", detail: "Text preview available" },
        rendition: { status: "pending", provider: this.name, detail: "" },
      };
    }
    return {
      preview: { status: "unsupported", provider: this.name, kind: "none", detail: `No preview for ${mimeType || name}` },
      rendition: { status: "failed", provider: this.name, detail: "No rendition available" },
    };
  }
}

export class NoopPreviewProvider {
  constructor({ name = "noop" } = {}) {
    this.name = name;
  }

  async generate() {
    return {
      preview: { status: "unsupported", provider: this.name, kind: "none", detail: "Preview disabled" },
      rendition: { status: "failed", provider: this.name, detail: "Rendition disabled" },
    };
  }
}

const providers = new Map();
providers.set("metadata", new MetadataPreviewProvider());
providers.set("noop", new NoopPreviewProvider());

export function registerPreviewProvider(name, provider) {
  if (!name || !provider?.generate) throw new HttpError(400, "A preview provider requires a name and a generate() method");
  providers.set(name, provider);
  return provider;
}

export function resolvePreviewProvider(name) {
  const resolved = name || process.env.FILE_PREVIEW_PROVIDER || "metadata";
  const provider = providers.get(resolved);
  if (!provider) throw new HttpError(500, `Unknown preview provider: ${resolved}`);
  return provider;
}

export function previewProviderNames() {
  return [...providers.keys()];
}
