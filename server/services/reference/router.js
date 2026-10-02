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

export function createReferenceRouter({ express, db, auth, can, authAsync, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const domainOf = (req) => Domains.requireDomain(db, req.params.ref ?? req.params.domainRef);
  const domainOfAsync = (req) => Domains.requireDomainAsync(db, req.params.ref ?? req.params.domainRef);

  const canDomains = (action) => canAsync("iam.reference.domains", action);
  const canItems = (action) => canAsync("iam.reference.items", action);
  const canCodes = (action) => canAsync("iam.reference.codes", action);
  const canAliases = (action) => canAsync("iam.reference.aliases", action);
  const canTranslations = (action) => canAsync("iam.reference.translations", action);
  const canHierarchy = (action) => canAsync("iam.reference.hierarchy", action);
  const canRelationships = (action) => canAsync("iam.reference.relationships", action);
  const canScopes = (action) => canAsync("iam.reference.scopes", action);
  const canVersions = (action) => canAsync("iam.reference.versions", action);
  const canApprovals = (action) => canAsync("iam.reference.approvals", action);
  const canGovernance = (action) => canAsync("iam.reference.governance", action);
  const canImport = (action) => canAsync("iam.reference.import", action);
  const canExport = (action) => canAsync("iam.reference.export", action);
  const canResolve = (action) => canAsync("iam.reference.resolve", action);
  const canMetrics = (action) => canAsync("iam.reference.metrics", action);

  router.get(
    "/meta",
    authAsync,
    canAsync("iam.reference", "read"),
    wrap(async (_req, res) => {
      res.json({ ...Validation.vocabulary(), ...Foundation.vocabulary(), cache_epoch: (await Metrics.metricsSnapshotAsync(db)).cache_epoch });
    })
  );

  // ── Domains ───────────────────────────────────────────────────────────────
  router.get(
    "/domains",
    authAsync,
    canDomains("read"),
    wrap(async (req, res) => res.json(await Domains.listDomainsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/domains",
    authAsync,
    canDomains("create"),
    wrap(async (req, res) => res.status(201).json(await Domains.createDomainAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/domains/:ref",
    authAsync,
    canDomains("read"),
    wrap(async (req, res) => res.json(await Domains.getDomainAsync(db, req.params.ref)))
  );
  const updateDomainHandler = wrap(async (req, res) => res.json(await Domains.updateDomainAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/domains/:ref", authAsync, canDomains("update"), updateDomainHandler);
  router.patch("/domains/:ref", authAsync, canDomains("update"), updateDomainHandler);
  router.post(
    "/domains/:ref/status",
    authAsync,
    canDomains("execute"),
    wrap(async (req, res) => res.json(await Domains.setDomainStatusAsync(db, req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.get(
    "/domains/:ref/governance",
    authAsync,
    canGovernance("read"),
    wrap(async (req, res) => {
      const domain = await domainOfAsync(req);
      res.json({
        active: await Governance.getActiveGovernancePolicyAsync(db, domain.id),
        versions: await Governance.listGovernanceVersionsAsync(db, domain.id),
      });
    })
  );
  router.post(
    "/domains/:ref/governance",
    authAsync,
    canGovernance("update"),
    wrap(async (req, res) => {
      const domain = await domainOfAsync(req);
      res.status(201).json(await Governance.publishGovernanceVersionAsync(db, domain, req.body || {}, req.actor, req.ip));
    })
  );
  router.get(
    "/domains/:ref/ownership-history",
    authAsync,
    canDomains("read"),
    wrap(async (req, res) => {
      const domain = await domainOfAsync(req);
      res.json({ items: await Domains.listOwnershipHistoryAsync(db, { domainId: domain.id, limit: req.query.limit }) });
    })
  );
  router.get(
    "/domains/:ref/tree",
    authAsync,
    canHierarchy("read"),
    wrap(async (req, res) => {
      const domain = await domainOfAsync(req);
      res.json({
        domain: await Domains.publicDomainAsync(domain, { includeGovernance: false }),
        tree: await Hierarchy.treeAsync(db, domain.id, { rootId: req.query.rootId }),
      });
    })
  );

  // ── Items ─────────────────────────────────────────────────────────────────
  router.get(
    "/items",
    authAsync,
    canItems("read"),
    wrap(async (req, res) => res.json(await Items.listItemsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/items",
    authAsync,
    canItems("create"),
    wrap(async (req, res) => res.status(201).json(await Items.createItemAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/items/:ref",
    authAsync,
    canItems("read"),
    wrap(async (req, res) => res.json(await Items.getItemAsync(db, req.params.ref, { includeChildren: req.query.includeChildren !== "false" })))
  );
  const updateItemHandler = wrap(async (req, res) => res.json(await Items.updateItemAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/items/:ref", authAsync, canItems("update"), updateItemHandler);
  router.patch("/items/:ref", authAsync, canItems("update"), updateItemHandler);
  router.delete(
    "/items/:ref",
    authAsync,
    canItems("delete"),
    wrap(async (req, res) => res.json(await Items.deleteItemAsync(db, req.params.ref, req.actor, req.ip)))
  );
  const statusHandler = (status) =>
    wrap(async (req, res) => res.json(await Items.setItemStatusAsync(db, req.params.ref, status, req.actor, req.ip, { reason: req.body?.reason, changeSummary: req.body?.change_summary })));
  router.post("/items/:ref/status", authAsync, canItems("execute"), wrap(async (req, res) => res.json(await Items.setItemStatusAsync(db, req.params.ref, req.body?.status, req.actor, req.ip, { reason: req.body?.reason, changeSummary: req.body?.change_summary }))));
  router.post("/items/:ref/submit", authAsync, canItems("execute"), statusHandler("submitted"));
  router.post("/items/:ref/approve", authAsync, canItems("execute"), statusHandler("approved"));
  router.post("/items/:ref/activate", authAsync, canItems("execute"), statusHandler("active"));
  router.post("/items/:ref/inactivate", authAsync, canItems("execute"), statusHandler("inactive"));
  router.post("/items/:ref/retire", authAsync, canItems("execute"), statusHandler("retired"));
  router.post("/items/:ref/reject", authAsync, canItems("execute"), statusHandler("rejected"));
  router.get(
    "/items/:ref/versions",
    authAsync,
    canVersions("read"),
    wrap(async (req, res) => res.json(await Versions.listVersionsAsync(db, (await Items.requireItemAsync(db, req.params.ref)).id, { limit: req.query.limit })))
  );
  router.get(
    "/items/:ref/relationships",
    authAsync,
    canRelationships("read"),
    wrap(async (req, res) => res.json({ items: await Relationships.relatedItemsAsync(db, (await Items.requireItemAsync(db, req.params.ref)).id, { relationshipType: req.query.type, direction: req.query.direction }) }))
  );

  // ── Codes ─────────────────────────────────────────────────────────────────
  router.get(
    "/items/:ref/codes",
    authAsync,
    canCodes("read"),
    wrap(async (req, res) => res.json(await Codes.listCodesAsync(db, { itemId: (await Items.requireItemAsync(db, req.params.ref)).id, limit: req.query.limit })))
  );
  router.post(
    "/items/:ref/codes",
    authAsync,
    canCodes("create"),
    wrap(async (req, res) => {
      const item = await Items.requireItemAsync(db, req.params.ref);
      res.status(201).json(await Codes.createCodeAsync(db, item, req.body || {}, req.actor, tenantOf(req), req.ip));
    })
  );
  router.get("/codes", authAsync, canCodes("read"), wrap(async (req, res) => res.json(await Codes.listCodesAsync(db, req.query))));
  router.get(
    "/codes/:ref",
    authAsync,
    canCodes("read"),
    wrap(async (req, res) => res.json(Codes.publicCode(await Codes.getCodeRowAsync(db, req.params.ref))))
  );
  router.patch(
    "/codes/:ref",
    authAsync,
    canCodes("update"),
    wrap(async (req, res) => res.json(await Codes.updateCodeAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.delete(
    "/codes/:ref",
    authAsync,
    canCodes("delete"),
    wrap(async (req, res) => res.json(await Codes.deleteCodeAsync(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Aliases ───────────────────────────────────────────────────────────────
  router.get(
    "/items/:ref/aliases",
    authAsync,
    canAliases("read"),
    wrap(async (req, res) => res.json(await Aliases.listAliasesAsync(db, { itemId: (await Items.requireItemAsync(db, req.params.ref)).id, limit: req.query.limit })))
  );
  router.post(
    "/items/:ref/aliases",
    authAsync,
    canAliases("create"),
    wrap(async (req, res) => {
      const item = await Items.requireItemAsync(db, req.params.ref);
      res.status(201).json(await Aliases.createAliasAsync(db, item, req.body || {}, req.actor, tenantOf(req), req.ip));
    })
  );
  router.get("/aliases", authAsync, canAliases("read"), wrap(async (req, res) => res.json(await Aliases.listAliasesAsync(db, req.query))));
  router.patch(
    "/aliases/:ref",
    authAsync,
    canAliases("update"),
    wrap(async (req, res) => res.json(await Aliases.updateAliasAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.delete(
    "/aliases/:ref",
    authAsync,
    canAliases("delete"),
    wrap(async (req, res) => res.json(await Aliases.deleteAliasAsync(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Translations ──────────────────────────────────────────────────────────
  router.get(
    "/items/:ref/translations",
    authAsync,
    canTranslations("read"),
    wrap(async (req, res) => res.json(await Translations.listTranslationsAsync(db, { itemId: (await Items.requireItemAsync(db, req.params.ref)).id, limit: req.query.limit })))
  );
  router.post(
    "/items/:ref/translations",
    authAsync,
    canTranslations("create"),
    wrap(async (req, res) => {
      const item = await Items.requireItemAsync(db, req.params.ref);
      res.status(201).json(await Translations.upsertTranslationAsync(db, item, req.body || {}, req.actor, tenantOf(req), req.ip));
    })
  );
  router.get("/translations", authAsync, canTranslations("read"), wrap(async (req, res) => res.json(await Translations.listTranslationsAsync(db, req.query))));
  router.delete(
    "/translations/:ref",
    authAsync,
    canTranslations("delete"),
    wrap(async (req, res) => res.json(await Translations.deleteTranslationAsync(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Hierarchy ─────────────────────────────────────────────────────────────
  router.get("/hierarchy", authAsync, canHierarchy("read"), wrap(async (req, res) => res.json(await Hierarchy.listEdgesAsync(db, req.query))));
  router.post(
    "/hierarchy",
    authAsync,
    canHierarchy("create"),
    wrap(async (req, res) => res.status(201).json(await Hierarchy.createEdgeAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/hierarchy/:ref/descendants",
    authAsync,
    canHierarchy("read"),
    wrap(async (req, res) => {
      const edge = await Hierarchy.getEdgeRowAsync(db, req.params.ref);
      res.json({ items: await Hierarchy.descendantsAsync(db, edge?.child_id ?? req.params.ref) });
    })
  );
  router.delete(
    "/hierarchy/:ref",
    authAsync,
    canHierarchy("delete"),
    wrap(async (req, res) => res.json(await Hierarchy.deleteEdgeAsync(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Relationships ─────────────────────────────────────────────────────────
  router.get("/relationships", authAsync, canRelationships("read"), wrap(async (req, res) => res.json(await Relationships.listRelationshipsAsync(db, req.query))));
  router.post(
    "/relationships",
    authAsync,
    canRelationships("create"),
    wrap(async (req, res) => res.status(201).json(await Relationships.createRelationshipAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.patch(
    "/relationships/:ref",
    authAsync,
    canRelationships("update"),
    wrap(async (req, res) => res.json(await Relationships.updateRelationshipAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.delete(
    "/relationships/:ref",
    authAsync,
    canRelationships("delete"),
    wrap(async (req, res) => res.json(await Relationships.deleteRelationshipAsync(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Versions ──────────────────────────────────────────────────────────────
  router.get(
    "/versions/:ref",
    authAsync,
    canVersions("read"),
    wrap(async (req, res) => res.json(await Versions.getVersionAsync(db, req.params.ref)))
  );
  router.get(
    "/versions/:ref/compare/:other",
    authAsync,
    canVersions("read"),
    wrap(async (req, res) => res.json(await Versions.compareVersionsAsync(db, req.params.ref, req.params.other)))
  );

  // ── Scope policies ────────────────────────────────────────────────────────
  router.get(
    "/scope-policies",
    authAsync,
    canScopes("read"),
    wrap(async (req, res) => res.json(await Scopes.listScopePoliciesAsync(db, { status: req.query.status, tenantId: tenantOf(req) })))
  );
  router.post(
    "/scope-policies",
    authAsync,
    canScopes("create"),
    wrap(async (req, res) => res.status(201).json(await Scopes.createScopePolicyAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/scope-policies/:ref",
    authAsync,
    canScopes("read"),
    wrap(async (req, res) => res.json(await Scopes.getScopePolicyAsync(db, req.params.ref)))
  );
  const updateScopeHandler = wrap(async (req, res) => res.json(await Scopes.updateScopePolicyAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/scope-policies/:ref", authAsync, canScopes("update"), updateScopeHandler);
  router.patch("/scope-policies/:ref", authAsync, canScopes("update"), updateScopeHandler);
  router.delete(
    "/scope-policies/:ref",
    authAsync,
    canScopes("delete"),
    wrap(async (req, res) => res.json(await Scopes.deleteScopePolicyAsync(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Resolution ────────────────────────────────────────────────────────────
  router.post(
    "/resolve",
    authAsync,
    canResolve("execute"),
    wrap(async (req, res) => {
      const result = await Resolution.resolveValueAsync(db, req.body || {}, { tenantId: tenantOf(req) });
      res.json(result);
    })
  );
  router.post(
    "/resolve/bulk",
    authAsync,
    canResolve("execute"),
    wrap(async (req, res) => res.json(await Resolution.resolveBulkAsync(db, req.body || {}, { tenantId: tenantOf(req) })))
  );
  router.post(
    "/lookup",
    authAsync,
    canResolve("execute"),
    wrap(async (req, res) => res.json((await Resolution.lookupValueAsync(db, req.body || {}, { tenantId: tenantOf(req) })) ?? { resolution_status: "NOT_FOUND" }))
  );
  router.post(
    "/validate",
    authAsync,
    canResolve("read"),
    wrap(async (req, res) => res.json(await Resolution.validateValueAsync(db, req.body || {}, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/values",
    authAsync,
    canResolve("read"),
    wrap(async (req, res) => res.json(await Resolution.listValuesAsync(db, req.query, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/search",
    authAsync,
    canResolve("read"),
    wrap(async (req, res) => res.json(await Resolution.searchValuesAsync(db, req.query, { tenantId: tenantOf(req) })))
  );

  // ── Approvals ─────────────────────────────────────────────────────────────
  router.get("/approvals", authAsync, canApprovals("read"), wrap(async (req, res) => res.json(await Approvals.listApprovalsAsync(db, req.query))));
  router.get(
    "/approvals/:ref",
    authAsync,
    canApprovals("read"),
    wrap(async (req, res) => res.json(await Approvals.getApprovalAsync(db, req.params.ref)))
  );
  router.post(
    "/items/:ref/approvals",
    authAsync,
    canApprovals("create"),
    wrap(async (req, res) => res.status(201).json(await Approvals.submitForApprovalAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.post(
    "/approvals/:ref/decide",
    authAsync,
    canApprovals("execute"),
    wrap(async (req, res) => res.json(await Approvals.decideApprovalAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );

  // ── Change requests ───────────────────────────────────────────────────────
  router.get("/change-requests", authAsync, canGovernance("read"), wrap(async (req, res) => res.json(await Approvals.listChangeRequestsAsync(db, req.query))));
  router.post(
    "/change-requests",
    authAsync,
    canGovernance("create"),
    wrap(async (req, res) => res.status(201).json(await Approvals.createChangeRequestAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.patch(
    "/change-requests/:ref",
    authAsync,
    canGovernance("update"),
    wrap(async (req, res) => res.json(await Approvals.updateChangeRequestAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );

  // ── Import / export ───────────────────────────────────────────────────────
  router.get("/imports", authAsync, canImport("read"), wrap(async (req, res) => res.json(await ImportExport.listImportsAsync(db, req.query))));
  router.post(
    "/imports",
    authAsync,
    canImport("create"),
    wrap(async (req, res) => res.status(201).json(await ImportExport.createImportAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/imports/:ref",
    authAsync,
    canImport("read"),
    wrap(async (req, res) => res.json(await ImportExport.getImportAsync(db, req.params.ref)))
  );
  router.post(
    "/imports/:ref/commit",
    authAsync,
    canImport("execute"),
    wrap(async (req, res) => res.json(await ImportExport.commitImportAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.get("/exports", authAsync, canExport("read"), wrap(async (req, res) => res.json(await ImportExport.listExportsAsync(db, req.query))));
  router.post(
    "/exports",
    authAsync,
    canExport("create"),
    wrap(async (req, res) => res.status(201).json(await ImportExport.createExportAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/exports/:ref",
    authAsync,
    canExport("read"),
    wrap(async (req, res) => res.json(await ImportExport.getExportAsync(db, req.params.ref)))
  );
  router.get(
    "/exports/:ref/download",
    authAsync,
    canExport("read"),
    wrap(async (req, res) => {
      const record = await ImportExport.getExportAsync(db, req.params.ref);
      res.setHeader("Content-Type", record.format === "json" ? "application/json" : record.format === "tsv" ? "text/tab-separated-values" : "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${record.export_ref}.${record.format}"`);
      res.send(record.content);
    })
  );

  // ── Reindex (stewardship) ─────────────────────────────────────────────────
  router.post(
    "/domains/:ref/reindex",
    authAsync,
    canDomains("execute"),
    wrap(async (req, res) => res.json(Search.reindexReferenceDomain(db, (await domainOfAsync(req)).id)))
  );

  // ── Metrics ───────────────────────────────────────────────────────────────
  router.get(
    "/metrics",
    authAsync,
    canMetrics("read"),
    wrap(async (req, res) => res.json(await Metrics.metricsSnapshotAsync(db, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/dashboard",
    authAsync,
    canMetrics("read"),
    wrap(async (req, res) => res.json(await Metrics.dashboardSummaryAsync(db, { tenantId: tenantOf(req) })))
  );
  router.get("/health/live", wrap((_req, res) => res.json({ status: "ok", live: true })));
  router.get(
    "/health/ready",
    wrap(async (req, res) => {
      const health = await Metrics.healthCheckAsync(db, { tenantId: tenantOf(req) });
      res.status(health.ready ? 200 : 503).json(health);
    })
  );

  return router;
}
