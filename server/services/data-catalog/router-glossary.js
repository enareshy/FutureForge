// REST router for the Business Glossary (terms, definitions, synonyms,
// relations and term mappings). Built as a factory so it reuses the
// application's auth, authorization and error middleware. Mounted at
// /api/glossary and /api/v1/glossary.
import { constants, Validation, Glossary, Metrics } from "./index.js";

const R = constants.CATALOG_RESOURCES;

export function createGlossaryRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const canGlossary = (a) => can(R.glossary, a);
  const canTerms = (a) => can(R.terms, a);
  const canMetrics = (a) => can(R.metrics, a);

  router.get(
    "/meta",
    auth,
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
    auth,
    canTerms("read"),
    wrap((req, res) => res.json(Glossary.listTerms(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/terms",
    auth,
    canTerms("create"),
    wrap((req, res) => res.status(201).json(Glossary.createTerm(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/terms/export",
    auth,
    canTerms("read"),
    wrap((req, res) => res.json({ items: Glossary.glossarySnapshot(db, tenantOf(req)) }))
  );
  router.get(
    "/terms/:ref",
    auth,
    canTerms("read"),
    wrap((req, res) => res.json(Glossary.getTerm(db, req.params.ref, { tenantId: tenantOf(req) })))
  );
  const updateTerm = wrap((req, res) => res.json(Glossary.updateTerm(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/terms/:ref", auth, canTerms("update"), updateTerm);
  router.patch("/terms/:ref", auth, canTerms("update"), updateTerm);

  // Lifecycle
  router.post(
    "/terms/:ref/submit",
    auth,
    canTerms("execute"),
    wrap((req, res) => res.json(Glossary.submitTerm(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.post(
    "/terms/:ref/approve",
    auth,
    canTerms("execute"),
    wrap((req, res) => res.json(Glossary.approveTerm(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.post(
    "/terms/:ref/reject",
    auth,
    canTerms("execute"),
    wrap((req, res) => res.json(Glossary.rejectTerm(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.post(
    "/terms/:ref/status",
    auth,
    canTerms("execute"),
    wrap((req, res) => res.json(Glossary.setTermStatus(db, req.params.ref, req.body?.status, req.actor, tenantOf(req), req.ip)))
  );

  // Definitions
  router.get(
    "/terms/:ref/definitions",
    auth,
    canTerms("read"),
    wrap((req, res) => {
      const term = Glossary.requireTerm(db, req.params.ref, tenantOf(req));
      res.json({ items: Glossary.listTermDefinitions(db, term.id) });
    })
  );
  router.put(
    "/terms/:ref/definitions/:type",
    auth,
    canTerms("update"),
    wrap((req, res) => res.json(Glossary.upsertDefinition(db, req.params.ref, { ...(req.body || {}), definition_type: req.params.type }, req.actor, tenantOf(req), req.ip)))
  );
  router.delete(
    "/terms/:ref/definitions/:type",
    auth,
    canTerms("delete"),
    wrap((req, res) => res.json(Glossary.deleteDefinition(db, req.params.ref, req.params.type, req.actor, tenantOf(req), req.ip)))
  );

  // Synonyms
  router.get(
    "/terms/:ref/synonyms",
    auth,
    canTerms("read"),
    wrap((req, res) => {
      const term = Glossary.requireTerm(db, req.params.ref, tenantOf(req));
      res.json({ items: Glossary.listTermSynonyms(db, term.id) });
    })
  );
  router.post(
    "/terms/:ref/synonyms",
    auth,
    canTerms("update"),
    wrap((req, res) => res.status(201).json(Glossary.addSynonym(db, req.params.ref, req.body || {}, req.actor, tenantOf(req))))
  );
  router.delete(
    "/terms/:ref/synonyms/:synonym",
    auth,
    canTerms("delete"),
    wrap((req, res) => res.json(Glossary.removeSynonym(db, req.params.ref, req.params.synonym, req.actor, tenantOf(req))))
  );

  // Relations
  router.get(
    "/terms/:ref/relations",
    auth,
    canTerms("read"),
    wrap((req, res) => {
      const term = Glossary.requireTerm(db, req.params.ref, tenantOf(req));
      res.json({ items: Glossary.listTermRelations(db, term.id) });
    })
  );
  router.post(
    "/terms/:ref/relations",
    auth,
    canTerms("update"),
    wrap((req, res) => res.status(201).json(Glossary.addRelation(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.delete(
    "/term-relations/:id",
    auth,
    canTerms("delete"),
    wrap((req, res) => res.json(Glossary.removeRelation(db, req.params.id, req.actor, tenantOf(req))))
  );

  // Mappings
  router.get(
    "/terms/:ref/mappings",
    auth,
    canTerms("read"),
    wrap((req, res) => {
      const term = Glossary.requireTerm(db, req.params.ref, tenantOf(req));
      res.json({ items: Glossary.listTermMappings(db, term.id) });
    })
  );
  router.post(
    "/terms/:ref/mappings",
    auth,
    canTerms("update"),
    wrap((req, res) => res.status(201).json(Glossary.addMapping(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.delete(
    "/term-mappings/:id",
    auth,
    canTerms("delete"),
    wrap((req, res) => res.json(Glossary.removeMapping(db, req.params.id, req.actor, tenantOf(req))))
  );
  router.get(
    "/term-mappings",
    auth,
    canTerms("read"),
    wrap((req, res) => res.json({ items: Glossary.termsForTarget(db, tenantOf(req), req.query.target_type, req.query.target_id) }))
  );

  router.get(
    "/metrics",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Metrics.metricsSnapshot(db, { tenantId: tenantOf(req) })))
  );

  return router;
}
