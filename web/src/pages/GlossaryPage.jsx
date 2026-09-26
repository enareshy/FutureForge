import React, { useEffect, useState } from "react";
import { glossary } from "../api.js";

const emptyTerm = { code: "", name: "", definition: "", description: "" };

function Badge({ children, tone }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function approvalTone(status) {
  if (status === "approved" || status === "active") return "ok";
  if (status === "rejected") return "danger";
  return "warn";
}

export default function GlossaryPage() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState(null);
  const [terms, setTerms] = useState([]);
  const [selected, setSelected] = useState(null);
  const [definitions, setDefinitions] = useState([]);
  const [synonyms, setSynonyms] = useState([]);
  const [relations, setRelations] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [termForm, setTermForm] = useState(emptyTerm);
  const [synonymForm, setSynonymForm] = useState("");
  const [mappingForm, setMappingForm] = useState({ target_type: "OBJECT", target_id: "" });

  async function refresh() {
    setError("");
    try {
      const [m, t] = await Promise.all([glossary.meta(), glossary.terms("?pageSize=100")]);
      setMeta(m);
      setTerms(t.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function run(action) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function openTerm(ref) {
    setBusy(true);
    setError("");
    try {
      const [term, defs, syns, rels, maps] = await Promise.all([
        glossary.term(ref),
        glossary.definitions(ref),
        glossary.synonyms(ref),
        glossary.relations(ref),
        glossary.mappings(ref),
      ]);
      setSelected(term);
      setDefinitions(defs.items || []);
      setSynonyms(syns.items || []);
      setRelations(rels.items || []);
      setMappings(maps.items || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function reloadDetail(ref) {
    try {
      const [term, defs, syns, rels, maps] = await Promise.all([
        glossary.term(ref),
        glossary.definitions(ref),
        glossary.synonyms(ref),
        glossary.relations(ref),
        glossary.mappings(ref),
      ]);
      setSelected(term);
      setDefinitions(defs.items || []);
      setSynonyms(syns.items || []);
      setRelations(rels.items || []);
      setMappings(maps.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Business glossary</div>
          <h1>Business glossary</h1>
          <p className="sub">
            Canonical business terms, definitions, synonyms, relations and mappings to catalog objects. Terms follow a
            review-and-approval lifecycle driven by the platform Workflow engine.
          </p>
        </div>
        <div className="stack-row">
          <button className="btn ghost" onClick={refresh} disabled={busy}>
            Refresh
          </button>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <ul className="hint">
        <li>Status lifecycle: draft → in_review → approved → active (deprecated/retired allowed).</li>
        <li>Submitting a term starts the platform approval workflow; approving publishes the term to the catalog.</li>
      </ul>

      <form
        className="panel"
        onSubmit={(event) => {
          event.preventDefault();
          run(async () => {
            await glossary.createTerm(termForm);
            setTermForm(emptyTerm);
          });
        }}
      >
        <div className="row">
          <label className="field grow">
            <span>Code</span>
            <input value={termForm.code} onChange={(e) => setTermForm({ ...termForm, code: e.target.value })} required />
          </label>
          <label className="field grow">
            <span>Name</span>
            <input value={termForm.name} onChange={(e) => setTermForm({ ...termForm, name: e.target.value })} />
          </label>
        </div>
        <label className="field">
          <span>Definition</span>
          <input value={termForm.definition} onChange={(e) => setTermForm({ ...termForm, definition: e.target.value })} />
        </label>
        <button className="btn" disabled={busy}>
          Create term
        </button>
      </form>

      <div className="panel">
        <h3>Terms ({terms.length})</h3>
        {terms.map((term) => (
          <div className="row" key={term.id}>
            <div className="grow">
              <div className="mono">
                <Badge tone={approvalTone(term.approval_status)}>{term.approval_status}</Badge> {term.code} · {term.name} ·{" "}
                {term.status}
              </div>
              <div className="mono muted">{term.definition || term.description || "no definition"}</div>
            </div>
            <button className="btn ghost" disabled={busy} onClick={() => openTerm(term.term_ref)}>
              Open
            </button>
            {term.status === "draft" ? (
              <button className="btn ghost" disabled={busy} onClick={() => run(() => glossary.submitTerm(term.term_ref, {}))}>
                Submit
              </button>
            ) : null}
            {term.status === "in_review" ? (
              <>
                <button className="btn ghost" disabled={busy} onClick={() => run(() => glossary.approveTerm(term.term_ref, {}))}>
                  Approve
                </button>
                <button className="btn ghost" disabled={busy} onClick={() => run(() => glossary.rejectTerm(term.term_ref, {}))}>
                  Reject
                </button>
              </>
            ) : null}
          </div>
        ))}
        {terms.length === 0 ? <div className="mono">No business terms defined.</div> : null}
      </div>

      {selected ? (
        <>
          <div className="panel">
            <h3>
              {selected.code} · {selected.name}
              <span className="mono muted"> {selected.term_ref}</span>
            </h3>
            <div className="mono">{definitions.length} definition(s)</div>
            {definitions.map((definition) => (
              <div className="row" key={definition.id}>
                <div className="grow mono">
                  <Badge>{definition.definition_type}</Badge> {definition.definition}
                </div>
              </div>
            ))}
          </div>

          <div className="panel">
            <h3>Synonyms ({synonyms.length})</h3>
            <form
              className="row"
              onSubmit={(event) => {
                event.preventDefault();
                run(async () => {
                  await glossary.addSynonym(selected.term_ref, { synonym: synonymForm });
                  setSynonymForm("");
                  await reloadDetail(selected.term_ref);
                });
              }}
            >
              <label className="field grow">
                <span>Add synonym</span>
                <input value={synonymForm} onChange={(e) => setSynonymForm(e.target.value)} required />
              </label>
              <button className="btn ghost" disabled={busy}>
                Add
              </button>
            </form>
            {synonyms.map((synonym) => (
              <div className="row" key={synonym.id}>
                <div className="grow mono">
                  {synonym.synonym} · {synonym.synonym_type}
                </div>
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await glossary.removeSynonym(selected.term_ref, synonym.synonym);
                      await reloadDetail(selected.term_ref);
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            {synonyms.length === 0 ? <div className="mono">No synonyms.</div> : null}
          </div>

          <div className="panel">
            <h3>Relations ({relations.length})</h3>
            {relations.map((relation) => (
              <div className="row" key={relation.id}>
                <div className="grow mono">
                  {relation.relationship_type} · term #{relation.related_term_id}
                </div>
              </div>
            ))}
            {relations.length === 0 ? <div className="mono">No term relations.</div> : null}
          </div>

          <div className="panel">
            <h3>Mappings to catalog ({mappings.length})</h3>
            <form
              className="row"
              onSubmit={(event) => {
                event.preventDefault();
                run(async () => {
                  await glossary.addMapping(selected.term_ref, mappingForm);
                  setMappingForm({ target_type: "OBJECT", target_id: "" });
                  await reloadDetail(selected.term_ref);
                });
              }}
            >
              <label className="field">
                <span>Target type</span>
                <select
                  value={mappingForm.target_type}
                  onChange={(e) => setMappingForm({ ...mappingForm, target_type: e.target.value })}
                >
                  {(meta?.vocabularies?.term_target_types || ["OBJECT"]).map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </label>
              <label className="field grow">
                <span>Target id / ref</span>
                <input value={mappingForm.target_id} onChange={(e) => setMappingForm({ ...mappingForm, target_id: e.target.value })} required />
              </label>
              <button className="btn ghost" disabled={busy}>
                Map
              </button>
            </form>
            {mappings.map((mapping) => (
              <div className="row" key={mapping.id}>
                <div className="grow mono">
                  {mapping.target_type} · {mapping.target_ref || mapping.target_id}
                </div>
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await glossary.removeMapping(mapping.id);
                      await reloadDetail(selected.term_ref);
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            {mappings.length === 0 ? <div className="mono">No mappings.</div> : null}
          </div>
        </>
      ) : null}
    </>
  );
}
