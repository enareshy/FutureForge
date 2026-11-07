// REST router for the Business Glossary (terms, definitions, synonyms,
// relations and term mappings). Built as a factory so it reuses the
// application's auth, authorization and error middleware. Mounted at
// /api/glossary and /api/v1/glossary.
import { constants, Validation, Glossary, Metrics } from "./index.js";

const R = constants.CATALOG_RESOURCES;

export function createGlossaryRouter({ express, db, auth, authAsync, can, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const canGlossary = (a) => canAsync(R.glossary, a);
  const canTerms = (a) => canAsync(R.terms, a);
  const canMetrics = (a) => canAsync(R.metrics, a);

  router.get(
    "/meta",
    authAsync,
    canGlossary("read"),
    wrap((_req, res) => {
      res.json({
        source_module: constants.SOURCE_MODULE,
        vocabularies: {
          term_statuses: constants.TERM_STATUSES,
          term_approval_statuses: constants.TERM_APPROVAL_STATUSES,
          definition_types: constants.DEFINITION_TYPES,
          synonym_types: constants.SYNONYM_TYPES,
          term_relationship_types: constants.TERM_RELATIONSHIP_TYPES,
          term_target_types: constants.TERM_TARGET_TYPES,
        },
        workflow_code: Glossary.TERM_APPROVAL_WORKFLOW_CODE,
      });
    })
  );

  router.get(
    "/terms",
    authAsync,
    canTerms("read"),
    wrap(async (req, res) => res.json(await Glossary.listTermsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/terms",
    authAsync,
    canTerms("create"),
    wrap(async (req, res) => res.status(201).json(await Glossary.createTermAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/terms/export",
    authAsync,
    canTerms("read"),
    wrap(async (req, res) => res.json({ items: await Glossary.glossarySnapshotAsync(db, tenantOf(req)) }))
  );
  router.get(
    "/terms/:ref",
    authAsync,
    canTerms("read"),
    wrap(async (req, res) => res.json(await Glossary.getTermAsync(db, req.params.ref, { tenantId: tenantOf(req) })))
  );
  const updateTerm = wrap(async (req, res) => res.json(await Glossary.updateTermAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/terms/:ref", authAsync, canTerms("update"), updateTerm);
  router.patch("/terms/:ref", authAsync, canTerms("update"), updateTerm);

  // Lifecycle
  router.post(
    "/terms/:ref/submit",
    authAsync,
    canTerms("execute"),
    wrap(async (req, res) => res.json(await Glossary.submitTermAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.post(
    "/terms/:ref/approve",
    authAsync,
    canTerms("execute"),
    wrap(async (req, res) => res.json(await Glossary.approveTermAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.post(
    "/terms/:ref/reject",
    authAsync,
    canTerms("execute"),
    wrap(async (req, res) => res.json(await Glossary.rejectTermAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.post(
    "/terms/:ref/status",
    authAsync,
    canTerms("execute"),
    wrap(async (req, res) => res.json(await Glossary.setTermStatusAsync(db, req.params.ref, req.body?.status, req.actor, tenantOf(req), req.ip)))
  );

  // Definitions
  router.get(
    "/terms/:ref/definitions",
    authAsync,
    canTerms("read"),
    wrap(async (req, res) => {
      const term = await Glossary.requireTermAsync(db, req.params.ref, tenantOf(req));
      res.json({ items: await Glossary.listTermDefinitionsAsync(db, term.id) });
    })
  );
  router.put(
    "/terms/:ref/definitions/:type",
    authAsync,
    canTerms("update"),
    wrap(async (req, res) => res.json(await Glossary.upsertDefinitionAsync(db, req.params.ref, { ...(req.body || {}), definition_type: req.params.type }, req.actor, tenantOf(req), req.ip)))
  );
  router.delete(
    "/terms/:ref/definitions/:type",
    authAsync,
    canTerms("delete"),
    wrap(async (req, res) => res.json(await Glossary.deleteDefinitionAsync(db, req.params.ref, req.params.type, req.actor, tenantOf(req), req.ip)))
  );

  // Synonyms
  router.get(
    "/terms/:ref/synonyms",
    authAsync,
    canTerms("read"),
    wrap(async (req, res) => {
      const term = await Glossary.requireTermAsync(db, req.params.ref, tenantOf(req));
      res.json({ items: await Glossary.listTermSynonymsAsync(db, term.id) });
    })
  );
  router.post(
    "/terms/:ref/synonyms",
    authAsync,
    canTerms("update"),
    wrap(async (req, res) => res.status(201).json(await Glossary.addSynonymAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req))))
  );
  router.delete(
    "/terms/:ref/synonyms/:synonym",
    authAsync,
    canTerms("delete"),
    wrap(async (req, res) => res.json(await Glossary.removeSynonymAsync(db, req.params.ref, req.params.synonym, req.actor, tenantOf(req))))
  );

  // Relations
  router.get(
    "/terms/:ref/relations",
    authAsync,
    canTerms("read"),
    wrap(async (req, res) => {
      const term = await Glossary.requireTermAsync(db, req.params.ref, tenantOf(req));
      res.json({ items: await Glossary.listTermRelationsAsync(db, term.id) });
    })
  );
  router.post(
    "/terms/:ref/relations",
    authAsync,
    canTerms("update"),
    wrap(async (req, res) => res.status(201).json(await Glossary.addRelationAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.delete(
    "/term-relations/:id",
    authAsync,
    canTerms("delete"),
    wrap(async (req, res) => res.json(await Glossary.removeRelationAsync(db, req.params.id, req.actor, tenantOf(req))))
  );

  // Mappings
  router.get(
    "/terms/:ref/mappings",
    authAsync,
    canTerms("read"),
    wrap(async (req, res) => {
      const term = await Glossary.requireTermAsync(db, req.params.ref, tenantOf(req));
      res.json({ items: await Glossary.listTermMappingsAsync(db, term.id) });
    })
  );
  router.post(
    "/terms/:ref/mappings",
    authAsync,
    canTerms("update"),
    wrap(async (req, res) => res.status(201).json(await Glossary.addMappingAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.delete(
    "/term-mappings/:id",
    authAsync,
    canTerms("delete"),
    wrap(async (req, res) => res.json(await Glossary.removeMappingAsync(db, req.params.id, req.actor, tenantOf(req))))
  );
  router.get(
    "/term-mappings",
    authAsync,
    canTerms("read"),
    wrap(async (req, res) => res.json({ items: await Glossary.termsForTargetAsync(db, tenantOf(req), req.query.target_type, req.query.target_id) }))
  );

  router.get(
    "/metrics",
    authAsync,
    canMetrics("read"),
    wrap(async (req, res) => res.json(await Metrics.metricsSnapshotAsync(db, { tenantId: tenantOf(req) })))
  );

  return router;
}
