// REST router for the File & Content Management Service. Built as a factory so
// it can reuse the application's auth, authorization and error-wrapping
// middleware. Mounted at /api/content and /api/v1/content.
//
// Every data route runs entirely on the asynchronous layer: `authAsync` /
// `canAsync` guards and `*Async` service twins. Pure vocabulary and provider
// helpers (`Validation.*`, `Constants.*`, `Foundation.contentHealth`,
// `Storage.verifyDownloadToken`, `getStorageProvider`) remain synchronous.
import {
  Content,
  Sessions,
  Locks,
  Associations,
  Versions,
  Renditions,
  Processing,
  Security,
  Retention,
  Lifecycle,
  Metrics,
  Foundation,
  Validation,
  Repository,
  Storage,
  Constants,
} from "../content.js";
import { getStorageProvider } from "../file-storage/provider.js";
import { HttpError } from "../../validation.js";

export function createContentRouter({ express, db, auth, can, authAsync, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const ipOf = (req) => req.ip;
  const rawBody = express.raw({ type: () => true, limit: process.env.CONTENT_HTTP_UPLOAD_LIMIT || process.env.FILE_HTTP_UPLOAD_LIMIT || "64mb" });
  const bodyBuffer = (req) => (Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body?.data || "", "base64"));
  const contentOfAsync = (req) => Repository.findContentRowAsync(db, req.params.ref, tenantOf(req));

  const canBrowser = (action) => canAsync("iam.content.browser", action);
  const canDetails = (action) => canAsync("iam.content.details", action);
  const canUploads = (action) => canAsync("iam.content.uploads", action);
  const canVersions = (action) => canAsync("iam.content.versions", action);
  const canLocks = (action) => canAsync("iam.content.locks", action);
  const canAssociations = (action) => canAsync("iam.content.associations", action);
  const canRenditions = (action) => canAsync("iam.content.renditions", action);
  const canProcessing = (action) => canAsync("iam.content.processing", action);
  const canSecurity = (action) => canAsync("iam.content.security", action);
  const canRetention = (action) => canAsync("iam.content.retention", action);
  const canAdmin = (action) => canAsync("iam.content.admin", action);

  // ── Meta / health / metrics ────────────────────────────────────────────────
  router.get(
    "/meta",
    authAsync,
    canBrowser("read"),
    wrap((_req, res) => {
      res.json({
        ...Validation.vocabulary(),
        resource_permissions: Constants.RESOURCE_PERMISSION_MAP,
        event_types: Constants.CONTENT_EVENT_TYPES,
        health: Foundation.contentHealth(db),
      });
    })
  );
  router.get("/health", authAsync, wrap((_req, res) => res.json(Foundation.contentHealth(db))));
  router.get(
    "/metrics",
    authAsync,
    canAdmin("read"),
    wrap(async (req, res) => res.json(await Metrics.metricsSnapshotAsync(db, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/storage/summary",
    authAsync,
    canAdmin("read"),
    wrap(async (req, res) => res.json(await Metrics.storageSummaryAsync(db, { tenantId: tenantOf(req) })))
  );

  // ── Retention policies ─────────────────────────────────────────────────────
  router.get(
    "/retention-policies",
    authAsync,
    canRetention("read"),
    wrap(async (req, res) => res.json(await Retention.listRetentionPoliciesAsync(db, { tenantId: tenantOf(req), activeOnly: req.query.active === "true", limit: req.query.limit })))
  );
  router.post(
    "/retention-policies",
    authAsync,
    canRetention("update"),
    wrap(async (req, res) => res.status(201).json(await Retention.createRetentionPolicyAsync(db, req.body || {}, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.get(
    "/retention-policies/:ref",
    authAsync,
    canRetention("read"),
    wrap(async (req, res) => res.json(await Retention.getRetentionPolicyAsync(db, req.params.ref, tenantOf(req))))
  );
  router.patch(
    "/retention-policies/:ref",
    authAsync,
    canRetention("update"),
    wrap(async (req, res) => res.json(await Retention.updateRetentionPolicyAsync(db, req.params.ref, req.body || {}, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );

  // ── Processing jobs ────────────────────────────────────────────────────────
  router.get(
    "/processing-jobs",
    authAsync,
    canProcessing("read"),
    wrap(async (req, res) => res.json(await Processing.listProcessingJobsAsync(db, { contentId: req.query.contentId || req.query.content_id, tenantId: tenantOf(req), status: req.query.status, limit: req.query.limit })))
  );

  // ── Upload sessions ────────────────────────────────────────────────────────
  router.get(
    "/uploads",
    authAsync,
    canUploads("read"),
    wrap(async (req, res) => res.json(await Sessions.listUploadSessionsAsync(db, { tenantId: tenantOf(req), status: req.query.status, limit: req.query.limit })))
  );
  router.post(
    "/uploads",
    authAsync,
    canUploads("create"),
    wrap(async (req, res) => res.status(201).json(await Sessions.initiateUploadSessionAsync(db, req.body || {}, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.get(
    "/uploads/:uploadId",
    authAsync,
    canUploads("read"),
    wrap(async (req, res) => {
      const session = await Sessions.getUploadSessionAsync(db, req.params.uploadId, tenantOf(req));
      res.json({ ...session, parts: await Sessions.uploadSessionPartsAsync(db, session.id) });
    })
  );
  router.put(
    "/uploads/:uploadId/parts/:partNumber",
    authAsync,
    canUploads("create"),
    rawBody,
    wrap(async (req, res) => {
      res.json(await Sessions.appendUploadPartAsync(db, req.params.uploadId, { partNumber: req.params.partNumber, buffer: bodyBuffer(req), tenantId: tenantOf(req), actor: req.actor }));
    })
  );
  router.post(
    "/uploads/:uploadId/complete",
    authAsync,
    canUploads("create"),
    rawBody,
    wrap(async (req, res) => {
      const payload = Buffer.isBuffer(req.body) ? { buffer: req.body } : (req.body || {});
      res.json(await Sessions.completeUploadSessionAsync(db, req.params.uploadId, { declaredChecksum: payload.checksum || payload.declaredChecksum, tenantId: tenantOf(req), actor: req.actor, ip: ipOf(req) }));
    })
  );
  router.post(
    "/uploads/:uploadId/abort",
    authAsync,
    canUploads("create"),
    wrap(async (req, res) => res.json(await Sessions.abortUploadSessionAsync(db, req.params.uploadId, { reason: req.body?.reason || "", tenantId: tenantOf(req), actor: req.actor })))
  );

  // ── Associations ───────────────────────────────────────────────────────────
  router.get(
    "/associations",
    authAsync,
    canAssociations("read"),
    wrap(async (req, res) => res.json(await Associations.listAssociationsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/associations",
    authAsync,
    canAssociations("create"),
    wrap(async (req, res) => res.status(201).json(await Associations.createAssociationAsync(db, req.body || {}, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.get(
    "/associations/:ref",
    authAsync,
    canAssociations("read"),
    wrap(async (req, res) => res.json(await Associations.getAssociationAsync(db, req.params.ref, tenantOf(req))))
  );
  router.patch(
    "/associations/:ref",
    authAsync,
    canAssociations("update"),
    wrap(async (req, res) => res.json(await Associations.updateAssociationAsync(db, req.params.ref, req.body || {}, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.delete(
    "/associations/:ref",
    authAsync,
    canAssociations("delete"),
    wrap(async (req, res) => res.json(await Associations.removeAssociationAsync(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.post(
    "/associations/:ref/primary",
    authAsync,
    canAssociations("update"),
    wrap(async (req, res) => res.json(await Associations.setPrimaryAssociationAsync(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.get(
    "/objects/:objectType/:objectId/content",
    authAsync,
    canAssociations("read"),
    wrap(async (req, res) => res.json(await Associations.listObjectContentAsync(db, req.params.objectType, req.params.objectId, { tenantId: tenantOf(req), includeInactive: req.query.includeInactive === "true" })))
  );

  // ── Locks ──────────────────────────────────────────────────────────────────
  router.get(
    "/locks",
    authAsync,
    canLocks("read"),
    wrap(async (req, res) => res.json(await Locks.listLocksAsync(db, { tenantId: tenantOf(req), activeOnly: req.query.active !== "false", limit: req.query.limit })))
  );

  // ── Signed download endpoint ───────────────────────────────────────────────
  router.get(
    "/download/:token",
    authAsync,
    wrap(async (req, res) => {
      const payload = Storage.verifyDownloadToken(req.params.token);
      const provider = getStorageProvider();
      const info = await provider.stat(payload.k);
      if (!info) throw new HttpError(404, "Stored object not found");
      const filename = Validation.sanitizeFilename(payload.f || "download");
      res.setHeader("Content-Type", payload.m || "application/octet-stream");
      res.setHeader("Content-Length", String(info.size ?? 0));
      res.setHeader("Content-Disposition", `${payload.d === "inline" ? "inline" : "attachment"}; filename="${filename}"`);
      provider.getStream(payload.k).pipe(res);
    })
  );

  // ── Content collection ─────────────────────────────────────────────────────
  router.get(
    "/",
    authAsync,
    canBrowser("read"),
    wrap(async (req, res) => res.json(await Content.listContentAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.get(
    "/facets",
    authAsync,
    canBrowser("read"),
    wrap(async (req, res) => res.json(await Content.contentFacetsAsync(db, { tenantId: tenantOf(req) })))
  );
  router.post(
    "/",
    authAsync,
    canUploads("create"),
    rawBody,
    wrap(async (req, res) => {
      const body = Buffer.isBuffer(req.body) ? {} : (req.body || {});
      const buffer = body.buffer || (Buffer.isBuffer(req.body) ? req.body : body.data ? Buffer.from(body.data, "base64") : null);
      if (!buffer) throw new HttpError(400, "Content creation requires an upload buffer");
      const fileName = body.fileName || body.name || req.query.name || req.headers["x-file-name"] || "upload.bin";
      const content = await Content.createContentAsync(
        db,
        {
          ...body,
          fileName,
          objectType: body.objectType || req.query.objectType || req.query.object_type,
          objectId: body.objectId || req.query.objectId || req.query.object_id,
          contentRole: body.contentRole || req.query.contentRole || req.query.content_role,
          description: body.description || req.query.description,
          buffer,
        },
        { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) }
      );
      res.status(201).json(content);
    })
  );

  router.get(
    "/:ref",
    authAsync,
    canBrowser("read"),
    wrap(async (req, res) => res.json(await Content.contentDetailAsync(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req) })))
  );
  router.patch(
    "/:ref",
    authAsync,
    canDetails("update"),
    wrap(async (req, res) => res.json(await Content.updateContentMetadataAsync(db, req.params.ref, req.body || {}, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.delete(
    "/:ref",
    authAsync,
    canAdmin("execute"),
    wrap(async (req, res) => res.json(await Content.softDeleteContentAsync(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), reason: req.body?.reason || "", ip: ipOf(req) })))
  );
  router.post(
    "/:ref/restore",
    authAsync,
    canAdmin("execute"),
    wrap(async (req, res) => res.json(await Content.restoreContentAsync(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );

  // ── Download ───────────────────────────────────────────────────────────────
  router.get(
    "/:ref/download",
    authAsync,
    canDetails("read"),
    wrap(async (req, res) => {
      const info = await Content.downloadInfoAsync(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), versionRef: req.query.version, expiresIn: req.query.expiresIn, disposition: req.query.disposition });
      await Content.recordDownloadAsync(db, await contentOfAsync(req), { actor: req.actor, ip: ipOf(req) });
      res.json(info);
    })
  );

  // ── Versions ───────────────────────────────────────────────────────────────
  router.get(
    "/:ref/versions",
    authAsync,
    canVersions("read"),
    wrap(async (req, res) => res.json(await Versions.listVersionsAsync(db, await contentOfAsync(req), { includeDeleted: req.query.includeDeleted === "true", limit: req.query.limit })))
  );
  router.post(
    "/:ref/versions",
    authAsync,
    canVersions("create"),
    wrap(async (req, res) => res.status(201).json(await Versions.restoreVersionAsync(db, await contentOfAsync(req), req.body?.version || req.body?.reference, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.get(
    "/:ref/versions/:version/download",
    authAsync,
    canDetails("read"),
    wrap(async (req, res) => res.json(await Content.downloadInfoAsync(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), versionRef: req.params.version, disposition: req.query.disposition })))
  );

  // ── Renditions ─────────────────────────────────────────────────────────────
  router.get(
    "/:ref/renditions",
    authAsync,
    canRenditions("read"),
    wrap(async (req, res) => res.json(await Renditions.listRenditionsAsync(db, await contentOfAsync(req), { status: req.query.status, type: req.query.type })))
  );
  router.post(
    "/:ref/renditions",
    authAsync,
    canRenditions("create"),
    wrap(async (req, res) => res.status(201).json(await Renditions.requestRenditionAsync(db, await contentOfAsync(req), { renditionType: req.body?.rendition_type || req.body?.type, sourceVersionId: req.body?.source_version_id, actor: req.actor, tenantId: tenantOf(req), metadata: req.body?.metadata || {} })))
  );
  router.get(
    "/:ref/renditions/:renditionRef/download",
    authAsync,
    canRenditions("read"),
    wrap(async (req, res) => {
      const content = await contentOfAsync(req);
      res.json(await Renditions.renditionAccessUrlAsync(db, content, req.params.renditionRef, { disposition: req.query.disposition }));
    })
  );

  // ── Processing / security ──────────────────────────────────────────────────
  router.get(
    "/:ref/processing",
    authAsync,
    canProcessing("read"),
    wrap(async (req, res) => res.json(await Processing.getProcessingStatusAsync(db, await contentOfAsync(req))))
  );
  router.post(
    "/:ref/processing",
    authAsync,
    canProcessing("execute"),
    wrap(async (req, res) => res.json(await Processing.requeueContentProcessingAsync(db, await contentOfAsync(req), { actor: req.actor, renditionTypes: req.body?.rendition_types || null })))
  );
  router.get(
    "/:ref/security",
    authAsync,
    canSecurity("read"),
    wrap(async (req, res) => {
      const content = await contentOfAsync(req);
      res.json({ latest: await Security.latestScanAsync(db, content.id), ...(await Security.listScansAsync(db, content.id, { tenantId: tenantOf(req), limit: req.query.limit })) });
    })
  );
  router.post(
    "/:ref/quarantine",
    authAsync,
    canSecurity("update"),
    wrap(async (req, res) => res.json(await Security.quarantineContentAsync(db, await contentOfAsync(req), { reason: req.body?.reason || "Security policy", actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.post(
    "/:ref/release-quarantine",
    authAsync,
    canSecurity("update"),
    wrap(async (req, res) => res.json(await Security.releaseQuarantineAsync(db, await contentOfAsync(req), { reason: req.body?.reason || "", actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  router.post(
    "/:ref/lifecycle",
    authAsync,
    canAdmin("execute"),
    wrap(async (req, res) => res.json(await Lifecycle.transitionContentAsync(db, await contentOfAsync(req), req.body?.status, { actor: req.actor, reason: req.body?.reason || "", ip: ipOf(req) })))
  );
  router.post(
    "/:ref/archive",
    authAsync,
    canAdmin("execute"),
    wrap(async (req, res) => res.json(await Lifecycle.archiveContentAsync(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), reason: req.body?.reason || "", ip: ipOf(req) })))
  );

  // ── Locks (per content) ────────────────────────────────────────────────────
  router.get(
    "/:ref/lock",
    authAsync,
    canLocks("read"),
    wrap(async (req, res) => res.json({ lock: await Locks.getActiveLockAsync(db, await contentOfAsync(req)) }))
  );
  router.post(
    "/:ref/checkout",
    authAsync,
    canLocks("create"),
    wrap(async (req, res) => res.status(201).json(await Locks.checkOutContentAsync(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), reason: req.body?.reason || "", ttlSeconds: req.body?.ttl_seconds, ip: ipOf(req) })))
  );
  router.post(
    "/:ref/checkin",
    authAsync,
    canLocks("execute"),
    rawBody,
    wrap(async (req, res) => {
      const body = Buffer.isBuffer(req.body) ? {} : (req.body || {});
      const buffer = body.buffer || (Buffer.isBuffer(req.body) ? req.body : body.data ? Buffer.from(body.data, "base64") : null);
      res.json(await Locks.checkInContentAsync(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), buffer, comment: body.comment || "", lockToken: body.lock_token || body.lockToken, ip: ipOf(req) }));
    })
  );
  router.post(
    "/:ref/unlock",
    authAsync,
    canLocks("delete"),
    wrap(async (req, res) => res.json(await Locks.forceReleaseLockAsync(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), reason: req.body?.reason || "", ip: ipOf(req) })))
  );

  // ── Associations (per content) ─────────────────────────────────────────────
  router.get(
    "/:ref/associations",
    authAsync,
    canAssociations("read"),
    wrap(async (req, res) => {
      const content = await contentOfAsync(req);
      res.json(await Associations.listAssociationsAsync(db, { contentId: content.id, tenantId: tenantOf(req), status: req.query.status, page: req.query.page, pageSize: req.query.pageSize }));
    })
  );

  // ── Content-scoped audit / retention ───────────────────────────────────────
  router.get(
    "/:ref/events",
    authAsync,
    canBrowser("read"),
    wrap(async (req, res) => {
      const content = await contentOfAsync(req);
      res.json(await Content.contentEventsAsync(db, { contentId: content.id, tenantId: tenantOf(req), eventType: req.query.type, limit: req.query.limit }));
    })
  );
  router.get(
    "/:ref/retention",
    authAsync,
    canRetention("read"),
    wrap(async (req, res) => res.json(await Retention.retentionForContentAsync(db, await contentOfAsync(req))))
  );
  router.post(
    "/:ref/legal-hold",
    authAsync,
    canRetention("execute"),
    wrap(async (req, res) => res.status(201).json(await Retention.applyLegalHoldAsync(db, await contentOfAsync(req), { reason: req.body?.reason || "", caseRef: req.body?.case_ref || "", actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.post(
    "/:ref/legal-hold/release",
    authAsync,
    canRetention("execute"),
    wrap(async (req, res) => res.json(await Retention.releaseLegalHoldAsync(db, await contentOfAsync(req), { reason: req.body?.reason || "", actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );

  return router;
}
