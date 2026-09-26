// REST router for the File & Content Management Service. Built as a factory so
// it can reuse the application's auth, authorization and error-wrapping
// middleware. Mounted at /api/content and /api/v1/content.
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

export function createContentRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const ipOf = (req) => req.ip;
  const rawBody = express.raw({ type: () => true, limit: process.env.CONTENT_HTTP_UPLOAD_LIMIT || process.env.FILE_HTTP_UPLOAD_LIMIT || "64mb" });
  const bodyBuffer = (req) => (Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body?.data || "", "base64"));
  const contentOf = (req) => Repository.findContentRow(db, req.params.ref, tenantOf(req));

  const canBrowser = (action) => can("iam.content.browser", action);
  const canDetails = (action) => can("iam.content.details", action);
  const canUploads = (action) => can("iam.content.uploads", action);
  const canVersions = (action) => can("iam.content.versions", action);
  const canLocks = (action) => can("iam.content.locks", action);
  const canAssociations = (action) => can("iam.content.associations", action);
  const canRenditions = (action) => can("iam.content.renditions", action);
  const canProcessing = (action) => can("iam.content.processing", action);
  const canSecurity = (action) => can("iam.content.security", action);
  const canRetention = (action) => can("iam.content.retention", action);
  const canAdmin = (action) => can("iam.content.admin", action);

  // ── Meta / health / metrics ────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
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
  router.get("/health", auth, wrap((_req, res) => res.json(Foundation.contentHealth(db))));
  router.get(
    "/metrics",
    auth,
    canAdmin("read"),
    wrap((req, res) => res.json(Metrics.metricsSnapshot(db, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/storage/summary",
    auth,
    canAdmin("read"),
    wrap((req, res) => res.json(Metrics.storageSummary(db, { tenantId: tenantOf(req) })))
  );

  // ── Retention policies ─────────────────────────────────────────────────────
  router.get(
    "/retention-policies",
    auth,
    canRetention("read"),
    wrap((req, res) => res.json(Retention.listRetentionPolicies(db, { tenantId: tenantOf(req), activeOnly: req.query.active === "true", limit: req.query.limit })))
  );
  router.post(
    "/retention-policies",
    auth,
    canRetention("update"),
    wrap((req, res) => res.status(201).json(Retention.createRetentionPolicy(db, req.body || {}, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.get(
    "/retention-policies/:ref",
    auth,
    canRetention("read"),
    wrap((req, res) => res.json(Retention.getRetentionPolicy(db, req.params.ref, tenantOf(req))))
  );
  router.patch(
    "/retention-policies/:ref",
    auth,
    canRetention("update"),
    wrap((req, res) => res.json(Retention.updateRetentionPolicy(db, req.params.ref, req.body || {}, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );

  // ── Processing jobs ────────────────────────────────────────────────────────
  router.get(
    "/processing-jobs",
    auth,
    canProcessing("read"),
    wrap((req, res) => res.json(Processing.listProcessingJobs(db, { contentId: req.query.contentId || req.query.content_id, tenantId: tenantOf(req), status: req.query.status, limit: req.query.limit })))
  );

  // ── Upload sessions ────────────────────────────────────────────────────────
  router.get(
    "/uploads",
    auth,
    canUploads("read"),
    wrap((req, res) => res.json(Sessions.listUploadSessions(db, { tenantId: tenantOf(req), status: req.query.status, limit: req.query.limit })))
  );
  router.post(
    "/uploads",
    auth,
    canUploads("create"),
    wrap((req, res) => res.status(201).json(Sessions.initiateUploadSession(db, req.body || {}, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.get(
    "/uploads/:uploadId",
    auth,
    canUploads("read"),
    wrap((req, res) => {
      const session = Sessions.getUploadSession(db, req.params.uploadId, tenantOf(req));
      res.json({ ...session, parts: Sessions.uploadSessionParts(db, session.id) });
    })
  );
  router.put(
    "/uploads/:uploadId/parts/:partNumber",
    auth,
    canUploads("create"),
    rawBody,
    wrap(async (req, res) => {
      res.json(await Sessions.appendUploadPart(db, req.params.uploadId, { partNumber: req.params.partNumber, buffer: bodyBuffer(req), tenantId: tenantOf(req), actor: req.actor }));
    })
  );
  router.post(
    "/uploads/:uploadId/complete",
    auth,
    canUploads("create"),
    rawBody,
    wrap(async (req, res) => {
      const payload = Buffer.isBuffer(req.body) ? { buffer: req.body } : (req.body || {});
      res.json(await Sessions.completeUploadSession(db, req.params.uploadId, { declaredChecksum: payload.checksum || payload.declaredChecksum, tenantId: tenantOf(req), actor: req.actor, ip: ipOf(req) }));
    })
  );
  router.post(
    "/uploads/:uploadId/abort",
    auth,
    canUploads("create"),
    wrap((req, res) => res.json(Sessions.abortUploadSession(db, req.params.uploadId, { reason: req.body?.reason || "", tenantId: tenantOf(req), actor: req.actor })))
  );

  // ── Associations ───────────────────────────────────────────────────────────
  router.get(
    "/associations",
    auth,
    canAssociations("read"),
    wrap((req, res) => res.json(Associations.listAssociations(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/associations",
    auth,
    canAssociations("create"),
    wrap((req, res) => res.status(201).json(Associations.createAssociation(db, req.body || {}, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.get(
    "/associations/:ref",
    auth,
    canAssociations("read"),
    wrap((req, res) => res.json(Associations.getAssociation(db, req.params.ref, tenantOf(req))))
  );
  router.patch(
    "/associations/:ref",
    auth,
    canAssociations("update"),
    wrap((req, res) => res.json(Associations.updateAssociation(db, req.params.ref, req.body || {}, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.delete(
    "/associations/:ref",
    auth,
    canAssociations("delete"),
    wrap((req, res) => res.json(Associations.removeAssociation(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.post(
    "/associations/:ref/primary",
    auth,
    canAssociations("update"),
    wrap((req, res) => res.json(Associations.setPrimaryAssociation(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.get(
    "/objects/:objectType/:objectId/content",
    auth,
    canAssociations("read"),
    wrap((req, res) => res.json(Associations.listObjectContent(db, req.params.objectType, req.params.objectId, { tenantId: tenantOf(req), includeInactive: req.query.includeInactive === "true" })))
  );

  // ── Locks ──────────────────────────────────────────────────────────────────
  router.get(
    "/locks",
    auth,
    canLocks("read"),
    wrap((req, res) => res.json(Locks.listLocks(db, { tenantId: tenantOf(req), activeOnly: req.query.active !== "false", limit: req.query.limit })))
  );

  // ── Signed download endpoint ───────────────────────────────────────────────
  router.get(
    "/download/:token",
    auth,
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
    auth,
    canBrowser("read"),
    wrap((req, res) => res.json(Content.listContent(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.get(
    "/facets",
    auth,
    canBrowser("read"),
    wrap((req, res) => res.json(Content.contentFacets(db, { tenantId: tenantOf(req) })))
  );
  router.post(
    "/",
    auth,
    canUploads("create"),
    rawBody,
    wrap(async (req, res) => {
      const body = Buffer.isBuffer(req.body) ? {} : (req.body || {});
      const buffer = body.buffer || (Buffer.isBuffer(req.body) ? req.body : body.data ? Buffer.from(body.data, "base64") : null);
      if (!buffer) throw new HttpError(400, "Content creation requires an upload buffer");
      const fileName = body.fileName || body.name || req.query.name || req.headers["x-file-name"] || "upload.bin";
      const content = await Content.createContent(
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
    auth,
    canBrowser("read"),
    wrap((req, res) => res.json(Content.contentDetail(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req) })))
  );
  router.patch(
    "/:ref",
    auth,
    canDetails("update"),
    wrap((req, res) => res.json(Content.updateContentMetadata(db, req.params.ref, req.body || {}, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.delete(
    "/:ref",
    auth,
    canAdmin("execute"),
    wrap((req, res) => res.json(Content.softDeleteContent(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), reason: req.body?.reason || "", ip: ipOf(req) })))
  );
  router.post(
    "/:ref/restore",
    auth,
    canAdmin("execute"),
    wrap((req, res) => res.json(Content.restoreContent(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );

  // ── Download ───────────────────────────────────────────────────────────────
  router.get(
    "/:ref/download",
    auth,
    canDetails("read"),
    wrap((req, res) => {
      const info = Content.downloadInfo(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), versionRef: req.query.version, expiresIn: req.query.expiresIn, disposition: req.query.disposition });
      Content.recordDownload(db, contentOf(req), { actor: req.actor, ip: ipOf(req) });
      res.json(info);
    })
  );

  // ── Versions ───────────────────────────────────────────────────────────────
  router.get(
    "/:ref/versions",
    auth,
    canVersions("read"),
    wrap((req, res) => res.json(Versions.listVersions(db, contentOf(req), { includeDeleted: req.query.includeDeleted === "true", limit: req.query.limit })))
  );
  router.post(
    "/:ref/versions",
    auth,
    canVersions("create"),
    wrap(async (req, res) => res.status(201).json(await Versions.restoreVersion(db, contentOf(req), req.body?.version || req.body?.reference, { actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.get(
    "/:ref/versions/:version/download",
    auth,
    canDetails("read"),
    wrap((req, res) => res.json(Content.downloadInfo(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), versionRef: req.params.version, disposition: req.query.disposition })))
  );

  // ── Renditions ─────────────────────────────────────────────────────────────
  router.get(
    "/:ref/renditions",
    auth,
    canRenditions("read"),
    wrap((req, res) => res.json(Renditions.listRenditions(db, contentOf(req), { status: req.query.status, type: req.query.type })))
  );
  router.post(
    "/:ref/renditions",
    auth,
    canRenditions("create"),
    wrap((req, res) => res.status(201).json(Renditions.requestRendition(db, contentOf(req), { renditionType: req.body?.rendition_type || req.body?.type, sourceVersionId: req.body?.source_version_id, actor: req.actor, tenantId: tenantOf(req), metadata: req.body?.metadata || {} })))
  );
  router.get(
    "/:ref/renditions/:renditionRef/download",
    auth,
    canRenditions("read"),
    wrap((req, res) => {
      const content = contentOf(req);
      res.json(Renditions.renditionAccessUrl(db, content, req.params.renditionRef, { disposition: req.query.disposition }));
    })
  );

  // ── Processing / security ──────────────────────────────────────────────────
  router.get(
    "/:ref/processing",
    auth,
    canProcessing("read"),
    wrap((req, res) => res.json(Processing.getProcessingStatus(db, contentOf(req))))
  );
  router.post(
    "/:ref/processing",
    auth,
    canProcessing("execute"),
    wrap(async (req, res) => res.json(await Processing.requeueContentProcessing(db, contentOf(req), { actor: req.actor, renditionTypes: req.body?.rendition_types || null })))
  );
  router.get(
    "/:ref/security",
    auth,
    canSecurity("read"),
    wrap((req, res) => {
      const content = contentOf(req);
      res.json({ latest: Security.latestScan(db, content.id), ...Security.listScans(db, content.id, { tenantId: tenantOf(req), limit: req.query.limit }) });
    })
  );
  router.post(
    "/:ref/quarantine",
    auth,
    canSecurity("update"),
    wrap((req, res) => res.json(Security.quarantineContent(db, contentOf(req), { reason: req.body?.reason || "Security policy", actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.post(
    "/:ref/release-quarantine",
    auth,
    canSecurity("update"),
    wrap((req, res) => res.json(Security.releaseQuarantine(db, contentOf(req), { reason: req.body?.reason || "", actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  router.post(
    "/:ref/lifecycle",
    auth,
    canAdmin("execute"),
    wrap((req, res) => res.json(Lifecycle.transitionContent(db, contentOf(req), req.body?.status, { actor: req.actor, reason: req.body?.reason || "", ip: ipOf(req) })))
  );
  router.post(
    "/:ref/archive",
    auth,
    canAdmin("execute"),
    wrap((req, res) => res.json(Lifecycle.archiveContent(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), reason: req.body?.reason || "", ip: ipOf(req) })))
  );

  // ── Locks (per content) ────────────────────────────────────────────────────
  router.get(
    "/:ref/lock",
    auth,
    canLocks("read"),
    wrap((req, res) => res.json({ lock: Locks.getActiveLock(db, contentOf(req)) }))
  );
  router.post(
    "/:ref/checkout",
    auth,
    canLocks("create"),
    wrap((req, res) => res.status(201).json(Locks.checkOutContent(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), reason: req.body?.reason || "", ttlSeconds: req.body?.ttl_seconds, ip: ipOf(req) })))
  );
  router.post(
    "/:ref/checkin",
    auth,
    canLocks("execute"),
    rawBody,
    wrap(async (req, res) => {
      const body = Buffer.isBuffer(req.body) ? {} : (req.body || {});
      const buffer = body.buffer || (Buffer.isBuffer(req.body) ? req.body : body.data ? Buffer.from(body.data, "base64") : null);
      res.json(await Locks.checkInContent(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), buffer, comment: body.comment || "", lockToken: body.lock_token || body.lockToken, ip: ipOf(req) }));
    })
  );
  router.post(
    "/:ref/unlock",
    auth,
    canLocks("delete"),
    wrap((req, res) => res.json(Locks.forceReleaseLock(db, req.params.ref, { actor: req.actor, tenantId: tenantOf(req), reason: req.body?.reason || "", ip: ipOf(req) })))
  );

  // ── Associations (per content) ─────────────────────────────────────────────
  router.get(
    "/:ref/associations",
    auth,
    canAssociations("read"),
    wrap((req, res) => {
      const content = contentOf(req);
      res.json(Associations.listAssociations(db, { contentId: content.id, tenantId: tenantOf(req), status: req.query.status, page: req.query.page, pageSize: req.query.pageSize }));
    })
  );

  // ── Content-scoped audit / retention ───────────────────────────────────────
  router.get(
    "/:ref/events",
    auth,
    canBrowser("read"),
    wrap((req, res) => {
      const content = contentOf(req);
      res.json(Content.contentEvents(db, { contentId: content.id, tenantId: tenantOf(req), eventType: req.query.type, limit: req.query.limit }));
    })
  );
  router.get(
    "/:ref/retention",
    auth,
    canRetention("read"),
    wrap((req, res) => res.json(Retention.retentionForContent(db, contentOf(req))))
  );
  router.post(
    "/:ref/legal-hold",
    auth,
    canRetention("execute"),
    wrap((req, res) => res.status(201).json(Retention.applyLegalHold(db, contentOf(req), { reason: req.body?.reason || "", caseRef: req.body?.case_ref || "", actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );
  router.post(
    "/:ref/legal-hold/release",
    auth,
    canRetention("execute"),
    wrap((req, res) => res.json(Retention.releaseLegalHold(db, contentOf(req), { reason: req.body?.reason || "", actor: req.actor, tenantId: tenantOf(req), ip: ipOf(req) })))
  );

  return router;
}
