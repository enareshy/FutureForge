// REST router for Enterprise Reference Data Management. Built as a factory so it
// can reuse the application's auth, authorization and error-wrapping middleware.
// Mounted at /api/reference-data and /api/v1/reference-data.
import {
  Foundation,
  Domains,
  Governance,
  Items,
  Codes,
  Aliases,
  Translations,
  Hierarchy,
  Relationships,
  Versions,
  Scopes,
  Resolution,
  Approvals,
  ImportExport,
  Search,
  Metrics,
  Validation,
} from "../reference.js";

export function createReferenceRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const domainOf = (req) => Domains.requireDomain(db, req.params.ref ?? req.params.domainRef);

  const canDomains = (action) => can("iam.reference.domains", action);
  const canItems = (action) => can("iam.reference.items", action);
  const canCodes = (action) => can("iam.reference.codes", action);
  const canAliases = (action) => can("iam.reference.aliases", action);
  const canTranslations = (action) => can("iam.reference.translations", action);
  const canHierarchy = (action) => can("iam.reference.hierarchy", action);
  const canRelationships = (action) => can("iam.reference.relationships", action);
  const canScopes = (action) => can("iam.reference.scopes", action);
  const canVersions = (action) => can("iam.reference.versions", action);
  const canApprovals = (action) => can("iam.reference.approvals", action);
  const canGovernance = (action) => can("iam.reference.governance", action);
  const canImport = (action) => can("iam.reference.import", action);
  const canExport = (action) => can("iam.reference.export", action);
  const canResolve = (action) => can("iam.reference.resolve", action);
  const canMetrics = (action) => can("iam.reference.metrics", action);

  router.get(
    "/meta",
    auth,
    can("iam.reference", "read"),
    wrap((_req, res) => {
      res.json({ ...Validation.vocabulary(), ...Foundation.vocabulary(), cache_epoch: Metrics.metricsSnapshot(db).cache_epoch });
    })
  );

  // ── Domains ───────────────────────────────────────────────────────────────
  router.get(
    "/domains",
    auth,
    canDomains("read"),
    wrap((req, res) => res.json(Domains.listDomains(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/domains",
    auth,
    canDomains("create"),
    wrap((req, res) => res.status(201).json(Domains.createDomain(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/domains/:ref",
    auth,
    canDomains("read"),
    wrap((req, res) => res.json(Domains.getDomain(db, req.params.ref)))
  );
  const updateDomainHandler = wrap((req, res) => res.json(Domains.updateDomain(db, req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/domains/:ref", auth, canDomains("update"), updateDomainHandler);
  router.patch("/domains/:ref", auth, canDomains("update"), updateDomainHandler);
  router.post(
    "/domains/:ref/status",
    auth,
    canDomains("execute"),
    wrap((req, res) => res.json(Domains.setDomainStatus(db, req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.get(
    "/domains/:ref/governance",
    auth,
    canGovernance("read"),
    wrap((req, res) => {
      const domain = domainOf(req);
      res.json({ active: Governance.getActiveGovernancePolicy(db, domain.id), versions: Governance.listGovernanceVersions(db, domain.id) });
    })
  );
  router.post(
    "/domains/:ref/governance",
    auth,
    canGovernance("update"),
    wrap((req, res) => {
      const domain = domainOf(req);
      res.status(201).json(Governance.publishGovernanceVersion(db, domain, req.body || {}, req.actor, req.ip));
    })
  );
  router.get(
    "/domains/:ref/ownership-history",
    auth,
    canDomains("read"),
    wrap((req, res) => {
      const domain = domainOf(req);
      res.json({ items: Domains.listOwnershipHistory(db, { domainId: domain.id, limit: req.query.limit }) });
    })
  );
  router.get(
    "/domains/:ref/tree",
    auth,
    canHierarchy("read"),
    wrap((req, res) => {
      const domain = domainOf(req);
      res.json({ domain: Domains.publicDomain(domain, { includeGovernance: false }), tree: Hierarchy.tree(db, domain.id, { rootId: req.query.rootId }) });
    })
  );

  // ── Items ─────────────────────────────────────────────────────────────────
  router.get(
    "/items",
    auth,
    canItems("read"),
    wrap((req, res) => res.json(Items.listItems(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/items",
    auth,
    canItems("create"),
    wrap((req, res) => res.status(201).json(Items.createItem(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/items/:ref",
    auth,
    canItems("read"),
    wrap((req, res) => res.json(Items.getItem(db, req.params.ref, { includeChildren: req.query.includeChildren !== "false" })))
  );
  const updateItemHandler = wrap((req, res) => res.json(Items.updateItem(db, req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/items/:ref", auth, canItems("update"), updateItemHandler);
  router.patch("/items/:ref", auth, canItems("update"), updateItemHandler);
  router.delete(
    "/items/:ref",
    auth,
    canItems("delete"),
    wrap((req, res) => res.json(Items.deleteItem(db, req.params.ref, req.actor, req.ip)))
  );
  const statusHandler = (status) =>
    wrap((req, res) => res.json(Items.setItemStatus(db, req.params.ref, status, req.actor, req.ip, { reason: req.body?.reason, changeSummary: req.body?.change_summary })));
  router.post("/items/:ref/status", auth, canItems("execute"), wrap((req, res) => res.json(Items.setItemStatus(db, req.params.ref, req.body?.status, req.actor, req.ip, { reason: req.body?.reason, changeSummary: req.body?.change_summary }))));
  router.post("/items/:ref/submit", auth, canItems("execute"), statusHandler("submitted"));
  router.post("/items/:ref/approve", auth, canItems("execute"), statusHandler("approved"));
  router.post("/items/:ref/activate", auth, canItems("execute"), statusHandler("active"));
  router.post("/items/:ref/inactivate", auth, canItems("execute"), statusHandler("inactive"));
  router.post("/items/:ref/retire", auth, canItems("execute"), statusHandler("retired"));
  router.post("/items/:ref/reject", auth, canItems("execute"), statusHandler("rejected"));
  router.get(
    "/items/:ref/versions",
    auth,
    canVersions("read"),
    wrap((req, res) => res.json(Versions.listVersions(db, Items.requireItem(db, req.params.ref).id, { limit: req.query.limit })))
  );
  router.get(
    "/items/:ref/relationships",
    auth,
    canRelationships("read"),
    wrap((req, res) => res.json({ items: Relationships.relatedItems(db, Items.requireItem(db, req.params.ref).id, { relationshipType: req.query.type, direction: req.query.direction }) }))
  );

  // ── Codes ─────────────────────────────────────────────────────────────────
  router.get(
    "/items/:ref/codes",
    auth,
    canCodes("read"),
    wrap((req, res) => res.json(Codes.listCodes(db, { itemId: Items.requireItem(db, req.params.ref).id, limit: req.query.limit })))
  );
  router.post(
    "/items/:ref/codes",
    auth,
    canCodes("create"),
    wrap((req, res) => {
      const item = Items.requireItem(db, req.params.ref);
      res.status(201).json(Codes.createCode(db, item, req.body || {}, req.actor, tenantOf(req), req.ip));
    })
  );
  router.get("/codes", auth, canCodes("read"), wrap((req, res) => res.json(Codes.listCodes(db, req.query))));
  router.get(
    "/codes/:ref",
    auth,
    canCodes("read"),
    wrap((req, res) => res.json(Codes.publicCode(Codes.getCodeRow(db, req.params.ref))))
  );
  router.patch(
    "/codes/:ref",
    auth,
    canCodes("update"),
    wrap((req, res) => res.json(Codes.updateCode(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.delete(
    "/codes/:ref",
    auth,
    canCodes("delete"),
    wrap((req, res) => res.json(Codes.deleteCode(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Aliases ───────────────────────────────────────────────────────────────
  router.get(
    "/items/:ref/aliases",
    auth,
    canAliases("read"),
    wrap((req, res) => res.json(Aliases.listAliases(db, { itemId: Items.requireItem(db, req.params.ref).id, limit: req.query.limit })))
  );
  router.post(
    "/items/:ref/aliases",
    auth,
    canAliases("create"),
    wrap((req, res) => {
      const item = Items.requireItem(db, req.params.ref);
      res.status(201).json(Aliases.createAlias(db, item, req.body || {}, req.actor, tenantOf(req), req.ip));
    })
  );
  router.get("/aliases", auth, canAliases("read"), wrap((req, res) => res.json(Aliases.listAliases(db, req.query))));
  router.patch(
    "/aliases/:ref",
    auth,
    canAliases("update"),
    wrap((req, res) => res.json(Aliases.updateAlias(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.delete(
    "/aliases/:ref",
    auth,
    canAliases("delete"),
    wrap((req, res) => res.json(Aliases.deleteAlias(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Translations ──────────────────────────────────────────────────────────
  router.get(
    "/items/:ref/translations",
    auth,
    canTranslations("read"),
    wrap((req, res) => res.json(Translations.listTranslations(db, { itemId: Items.requireItem(db, req.params.ref).id, limit: req.query.limit })))
  );
  router.post(
    "/items/:ref/translations",
    auth,
    canTranslations("create"),
    wrap((req, res) => {
      const item = Items.requireItem(db, req.params.ref);
      res.status(201).json(Translations.upsertTranslation(db, item, req.body || {}, req.actor, tenantOf(req), req.ip));
    })
  );
  router.get("/translations", auth, canTranslations("read"), wrap((req, res) => res.json(Translations.listTranslations(db, req.query))));
  router.delete(
    "/translations/:ref",
    auth,
    canTranslations("delete"),
    wrap((req, res) => res.json(Translations.deleteTranslation(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Hierarchy ─────────────────────────────────────────────────────────────
  router.get("/hierarchy", auth, canHierarchy("read"), wrap((req, res) => res.json(Hierarchy.listEdges(db, req.query))));
  router.post(
    "/hierarchy",
    auth,
    canHierarchy("create"),
    wrap((req, res) => res.status(201).json(Hierarchy.createEdge(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/hierarchy/:ref/descendants",
    auth,
    canHierarchy("read"),
    wrap((req, res) => res.json({ items: Hierarchy.descendants(db, Hierarchy.getEdgeRow(db, req.params.ref)?.child_id ?? req.params.ref) }))
  );
  router.delete(
    "/hierarchy/:ref",
    auth,
    canHierarchy("delete"),
    wrap((req, res) => res.json(Hierarchy.deleteEdge(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Relationships ─────────────────────────────────────────────────────────
  router.get("/relationships", auth, canRelationships("read"), wrap((req, res) => res.json(Relationships.listRelationships(db, req.query))));
  router.post(
    "/relationships",
    auth,
    canRelationships("create"),
    wrap((req, res) => res.status(201).json(Relationships.createRelationship(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.patch(
    "/relationships/:ref",
    auth,
    canRelationships("update"),
    wrap((req, res) => res.json(Relationships.updateRelationship(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.delete(
    "/relationships/:ref",
    auth,
    canRelationships("delete"),
    wrap((req, res) => res.json(Relationships.deleteRelationship(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Versions ──────────────────────────────────────────────────────────────
  router.get(
    "/versions/:ref",
    auth,
    canVersions("read"),
    wrap((req, res) => res.json(Versions.getVersion(db, req.params.ref)))
  );
  router.get(
    "/versions/:ref/compare/:other",
    auth,
    canVersions("read"),
    wrap((req, res) => res.json(Versions.compareVersions(db, req.params.ref, req.params.other)))
  );

  // ── Scope policies ────────────────────────────────────────────────────────
  router.get(
    "/scope-policies",
    auth,
    canScopes("read"),
    wrap((req, res) => res.json(Scopes.listScopePolicies(db, { status: req.query.status, tenantId: tenantOf(req) })))
  );
  router.post(
    "/scope-policies",
    auth,
    canScopes("create"),
    wrap((req, res) => res.status(201).json(Scopes.createScopePolicy(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/scope-policies/:ref",
    auth,
    canScopes("read"),
    wrap((req, res) => res.json(Scopes.getScopePolicy(db, req.params.ref)))
  );
  const updateScopeHandler = wrap((req, res) => res.json(Scopes.updateScopePolicy(db, req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/scope-policies/:ref", auth, canScopes("update"), updateScopeHandler);
  router.patch("/scope-policies/:ref", auth, canScopes("update"), updateScopeHandler);
  router.delete(
    "/scope-policies/:ref",
    auth,
    canScopes("delete"),
    wrap((req, res) => res.json(Scopes.deleteScopePolicy(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Resolution ────────────────────────────────────────────────────────────
  router.post(
    "/resolve",
    auth,
    canResolve("execute"),
    wrap((req, res) => {
      const result = Resolution.resolveValue(db, req.body || {}, { tenantId: tenantOf(req) });
      res.json(result);
    })
  );
  router.post(
    "/resolve/bulk",
    auth,
    canResolve("execute"),
    wrap((req, res) => res.json(Resolution.resolveBulk(db, req.body || {}, { tenantId: tenantOf(req) })))
  );
  router.post(
    "/lookup",
    auth,
    canResolve("execute"),
    wrap((req, res) => res.json(Resolution.lookupValue(db, req.body || {}, { tenantId: tenantOf(req) }) ?? { resolution_status: "NOT_FOUND" }))
  );
  router.post(
    "/validate",
    auth,
    canResolve("read"),
    wrap((req, res) => res.json(Resolution.validateValue(db, req.body || {}, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/values",
    auth,
    canResolve("read"),
    wrap((req, res) => res.json(Resolution.listValues(db, req.query, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/search",
    auth,
    canResolve("read"),
    wrap((req, res) => res.json(Resolution.searchValues(db, req.query, { tenantId: tenantOf(req) })))
  );

  // ── Approvals ─────────────────────────────────────────────────────────────
  router.get("/approvals", auth, canApprovals("read"), wrap((req, res) => res.json(Approvals.listApprovals(db, req.query))));
  router.get(
    "/approvals/:ref",
    auth,
    canApprovals("read"),
    wrap((req, res) => res.json(Approvals.getApproval(db, req.params.ref)))
  );
  router.post(
    "/items/:ref/approvals",
    auth,
    canApprovals("create"),
    wrap((req, res) => res.status(201).json(Approvals.submitForApproval(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.post(
    "/approvals/:ref/decide",
    auth,
    canApprovals("execute"),
    wrap((req, res) => res.json(Approvals.decideApproval(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );

  // ── Change requests ───────────────────────────────────────────────────────
  router.get("/change-requests", auth, canGovernance("read"), wrap((req, res) => res.json(Approvals.listChangeRequests(db, req.query))));
  router.post(
    "/change-requests",
    auth,
    canGovernance("create"),
    wrap((req, res) => res.status(201).json(Approvals.createChangeRequest(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.patch(
    "/change-requests/:ref",
    auth,
    canGovernance("update"),
    wrap((req, res) => res.json(Approvals.updateChangeRequest(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );

  // ── Import / export ───────────────────────────────────────────────────────
  router.get("/imports", auth, canImport("read"), wrap((req, res) => res.json(ImportExport.listImports(db, req.query))));
  router.post(
    "/imports",
    auth,
    canImport("create"),
    wrap((req, res) => res.status(201).json(ImportExport.createImport(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/imports/:ref",
    auth,
    canImport("read"),
    wrap((req, res) => res.json(ImportExport.getImport(db, req.params.ref)))
  );
  router.post(
    "/imports/:ref/commit",
    auth,
    canImport("execute"),
    wrap((req, res) => res.json(ImportExport.commitImport(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.get("/exports", auth, canExport("read"), wrap((req, res) => res.json(ImportExport.listExports(db, req.query))));
  router.post(
    "/exports",
    auth,
    canExport("create"),
    wrap((req, res) => res.status(201).json(ImportExport.createExport(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/exports/:ref",
    auth,
    canExport("read"),
    wrap((req, res) => res.json(ImportExport.getExport(db, req.params.ref)))
  );
  router.get(
    "/exports/:ref/download",
    auth,
    canExport("read"),
    wrap((req, res) => {
      const record = ImportExport.getExport(db, req.params.ref);
      res.setHeader("Content-Type", record.format === "json" ? "application/json" : record.format === "tsv" ? "text/tab-separated-values" : "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${record.export_ref}.${record.format}"`);
      res.send(record.content);
    })
  );

  // ── Reindex (stewardship) ─────────────────────────────────────────────────
  router.post(
    "/domains/:ref/reindex",
    auth,
    canDomains("execute"),
    wrap((req, res) => res.json(Search.reindexReferenceDomain(db, domainOf(req).id)))
  );

  // ── Metrics ───────────────────────────────────────────────────────────────
  router.get(
    "/metrics",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Metrics.metricsSnapshot(db, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/dashboard",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Metrics.dashboardSummary(db, { tenantId: tenantOf(req) })))
  );
  router.get("/health/live", wrap((_req, res) => res.json({ status: "ok", live: true })));
  router.get(
    "/health/ready",
    wrap((req, res) => {
      const health = Metrics.healthCheck(db, { tenantId: tenantOf(req) });
      res.status(health.ready ? 200 : 503).json(health);
    })
  );

  return router;
}
