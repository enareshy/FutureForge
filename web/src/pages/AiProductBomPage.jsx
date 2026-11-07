import React, { useEffect, useMemo, useState } from "react";
import { AiApiError, ai } from "../aiApi.js";

function describe(err) {
  if (err instanceof AiApiError) {
    const rid = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.code}: ${err.message}${rid}`;
  }
  return err?.message || "Request failed";
}

const TABS = [
  "Items",
  "BOMs",
  "Structure",
  "Compare",
  "Intelligence",
  "Quality",
  "Change impact",
];

const LIFECYCLE_TONES = {
  active: "active",
  released: "succeeded",
  draft: "draft",
  in_review: "pending",
  obsolete: "deprecated",
  archived: "disabled",
  superseded: "deprecated",
};

function toneFor(status) {
  return LIFECYCLE_TONES[status];
}

function Badge({ value }) {
  return (
    <span className={`badge${toneFor(value) ? ` ${toneFor(value)}` : ""}`}>
      {value || "-"}
    </span>
  );
}

function ItemTable({ items, onSelect, selectedId }) {
  if (!items?.length) return <p className="subtle">No items.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Key</th><th>Type</th><th>Name</th><th>UoM</th><th>Lifecycle</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className={selectedId === item.id ? "valid" : ""}>
            <td>
              <button className="link-btn" onClick={() => onSelect(item)}>
                {item.item_key}
              </button>
            </td>
            <td className="mono">{item.item_type}</td>
            <td>{item.name || "-"}</td>
            <td>{item.unit_of_measure}</td>
            <td><Badge value={item.lifecycle_status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BomTable({ boms, onSelect, selectedId }) {
  if (!boms?.length) return <p className="subtle">No BOMs.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Key</th><th>Type</th><th>Name</th><th>Root item</th><th>Lifecycle</th>
        </tr>
      </thead>
      <tbody>
        {boms.map((bom) => (
          <tr key={bom.id} className={selectedId === bom.id ? "valid" : ""}>
            <td>
              <button className="link-btn" onClick={() => onSelect(bom)}>
                {bom.bom_key}
              </button>
            </td>
            <td className="mono">{bom.bom_type}</td>
            <td>{bom.name || "-"}</td>
            <td>{bom.root_item_id ?? "-"}</td>
            <td><Badge value={bom.lifecycle_status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StructureTable({ rows }) {
  if (!rows?.length) return <p className="subtle">No structure rows.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Depth</th><th>Child</th><th>Name</th><th>Qty</th>
          <th>Cumulative</th><th>Find</th><th>Ref des</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.line_id}>
            <td>{row.depth}</td>
            <td className="mono">{row.child_item_key || row.child_item_id}</td>
            <td>{row.child_name || "-"}</td>
            <td>{row.quantity}</td>
            <td>{row.cumulative_quantity}</td>
            <td>{row.find_number || "-"}</td>
            <td>{row.is_reference ? "reference" : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DiffTable({ diffs }) {
  if (!diffs?.length) return <p className="subtle">No differences.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Change</th><th>Line</th><th>Child item</th><th>Attributes</th>
        </tr>
      </thead>
      <tbody>
        {diffs.map((diff, index) => (
          <tr key={`${diff.change_type}-${diff.line_key}-${diff.child_item_id}-${index}`}>
            <td><Badge value={diff.change_type} /></td>
            <td className="mono">{diff.line_key || "-"}</td>
            <td>{diff.child_item_id ?? "-"}</td>
            <td>{(diff.changes || []).join(", ") || "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IntelligenceTable({ rows }) {
  if (!rows?.length) return <p className="subtle">No rows.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Item</th><th>Name</th><th>Kind</th><th>Occurrences</th>
          <th>Score</th><th>Reason</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.item_id}-${row.kind}-${index}`}>
            <td className="mono">{row.item_key || row.item_id}</td>
            <td>{row.name || "-"}</td>
            <td><span className="badge">{row.kind}</span></td>
            <td>{row.occurrences}</td>
            <td>{Number(row.score || 0).toFixed(2)}</td>
            <td className="muted">{row.reason || "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AiProductBomPage() {
  const [tab, setTab] = useState("Items");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [stats, setStats] = useState(null);

  const [items, setItems] = useState([]);
  const [itemTotal, setItemTotal] = useState(0);
  const [itemQuery, setItemQuery] = useState("");
  const [itemTypeFilter, setItemTypeFilter] = useState("");
  const [selectedItem, setSelectedItem] = useState(null);
  const [revisions, setRevisions] = useState([]);

  const [boms, setBoms] = useState([]);
  const [bomTotal, setBomTotal] = useState(0);
  const [bomQuery, setBomQuery] = useState("");
  const [bomTypeFilter, setBomTypeFilter] = useState("");
  const [selectedBom, setSelectedBom] = useState(null);

  const [structure, setStructure] = useState(null);
  const [structureDepth, setStructureDepth] = useState(5);

  const [leftHeader, setLeftHeader] = useState("");
  const [rightHeader, setRightHeader] = useState("");
  const [comparison, setComparison] = useState(null);

  const [reuse, setReuse] = useState(null);
  const [duplicates, setDuplicates] = useState(null);
  const [whereUsedItem, setWhereUsedItem] = useState("");
  const [whereUsed, setWhereUsed] = useState(null);

  const [quality, setQuality] = useState(null);

  const [changeEntity, setChangeEntity] = useState("");
  const [impact, setImpact] = useState(null);

  const itemTypeCodes = useMemo(
    () => ["product", "part", "assembly", "component", "material"],
    [],
  );
  const bomTypeCodes = useMemo(() => ["EBOM", "MBOM", "BOP", "OTHER"], []);

  async function guard(fn) {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (err) {
      setError(describe(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function loadStats() {
    const data = await guard(() => ai.productStats());
    if (data) setStats(data);
  }

  async function loadItems() {
    const params = { limit: 25 };
    if (itemQuery) params.query = itemQuery;
    if (itemTypeFilter) params.item_types = itemTypeFilter;
    const page = await guard(() => ai.productItems(params));
    if (page) {
      setItems(page.items || []);
      setItemTotal(page.total || 0);
    }
  }

  async function loadBoms() {
    const params = { limit: 25 };
    if (bomQuery) params.query = bomQuery;
    if (bomTypeFilter) params.bom_type = bomTypeFilter;
    const page = await guard(() => ai.boms(params));
    if (page) {
      setBoms(page.items || []);
      setBomTotal(page.total || 0);
    }
  }

  useEffect(() => {
    loadStats();
    loadItems();
    loadBoms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectItem(item) {
    setSelectedItem(item);
    setRevisions([]);
    const detail = await guard(() => ai.productItem(item.id));
    if (detail) setSelectedItem(detail);
    const rows = await guard(() =>
      ai.productRevisions({ item_id: item.id, limit: 50 }),
    );
    if (rows) setRevisions(rows);
  }

  function selectBom(bom) {
    setSelectedBom(bom);
    setStructure(null);
    setQuality(null);
    setLeftHeader(String(bom.id));
  }

  async function loadStructure() {
    if (!selectedBom) return;
    const data = await guard(() =>
      ai.bomStructure(selectedBom.id, {
        max_depth: Number(structureDepth) || 5,
        limit: 500,
        direction: "down",
      }),
    );
    if (data) setStructure(data);
  }

  async function runComparison(e) {
    e.preventDefault();
    if (!leftHeader || !rightHeader) return;
    setComparison(null);
    const data = await guard(() =>
      ai.bomCompare({
        left_header_id: Number(leftHeader),
        right_header_id: Number(rightHeader),
      }),
    );
    if (data) setComparison(data);
  }

  async function loadReuse() {
    const data = await guard(() => ai.productReuse());
    if (data) setReuse(data);
  }

  async function loadDuplicates() {
    const data = await guard(() => ai.productDuplicates());
    if (data) setDuplicates(data);
  }

  async function runWhereUsed(e) {
    e.preventDefault();
    if (!whereUsedItem) return;
    setWhereUsed(null);
    const data = await guard(() => ai.bomWhereUsed(Number(whereUsedItem)));
    if (data) setWhereUsed(data);
  }

  async function loadQuality() {
    if (!selectedBom) return;
    const data = await guard(() => ai.bomQuality(selectedBom.id));
    if (data) setQuality(data);
  }

  async function runImpact(e) {
    e.preventDefault();
    if (!changeEntity) return;
    setImpact(null);
    const data = await guard(() =>
      ai.bomChangeImpact({ change_entity_id: Number(changeEntity), max_depth: 3 }),
    );
    if (data) setImpact(data);
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>Product & BOM intelligence</h1>
          <p className="sub">
            Tenant-scoped product items, revisions and BOMs linked to the
            knowledge graph. Structure, comparison, transformation proposals,
            reconciliation and reuse analytics honor object-level authorization.
          </p>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {stats ? (
        <div className="row" style={{ gap: 24, marginBottom: 16, flexWrap: "wrap" }}>
          <div><span className="muted">Items</span> <strong>{stats.items}</strong></div>
          <div><span className="muted">Products</span> <strong>{stats.products}</strong></div>
          <div><span className="muted">Parts</span> <strong>{stats.parts}</strong></div>
          <div><span className="muted">BOMs</span> <strong>{stats.eboms + stats.mboms}</strong></div>
          <div><span className="muted">Lines</span> <strong>{stats.bom_lines}</strong></div>
          <div><span className="muted">Orphan parts</span> <strong>{stats.orphan_parts}</strong></div>
        </div>
      ) : null}

      <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map((item) => (
          <button
            key={item}
            className={`btn ${tab === item ? "" : "ghost"}`}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === "Items" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head"><h3>Items ({itemTotal})</h3></div>
            <form
              className="row"
              style={{ gap: 8, marginBottom: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                loadItems();
              }}
            >
              <input
                placeholder="Search key or name"
                value={itemQuery}
                onChange={(e) => setItemQuery(e.target.value)}
              />
              <select
                value={itemTypeFilter}
                onChange={(e) => setItemTypeFilter(e.target.value)}
              >
                <option value="">All types</option>
                {itemTypeCodes.map((code) => (
                  <option key={code} value={code}>{code}</option>
                ))}
              </select>
              <button className="btn ghost" disabled={busy}>Search</button>
            </form>
            <ItemTable
              items={items}
              onSelect={selectItem}
              selectedId={selectedItem?.id}
            />
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Item detail</h3></div>
            {!selectedItem ? (
              <p className="subtle">Select an item to inspect it.</p>
            ) : (
              <>
                <ul className="detail-list">
                  <li>ID: {selectedItem.id}</li>
                  <li>Key: {selectedItem.item_key}</li>
                  <li>Type: <span className="mono">{selectedItem.item_type}</span></li>
                  <li>Name: {selectedItem.name || "-"}</li>
                  <li>Lifecycle: <Badge value={selectedItem.lifecycle_status} /></li>
                  <li>UoM: {selectedItem.unit_of_measure}</li>
                  <li>Classification: {selectedItem.classification}</li>
                  <li>Graph entity: {selectedItem.graph_entity_id ?? "-"}</li>
                </ul>
                <h3>Revisions</h3>
                {!revisions.length ? (
                  <p className="subtle">No revisions.</p>
                ) : (
                  <ul className="detail-list">
                    {revisions.map((rev) => (
                      <li key={rev.id}>
                        <span className="mono">{rev.revision}</span>{" "}
                        <Badge value={rev.lifecycle_status} /> v{rev.version}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === "BOMs" ? (
        <div className="split">
          <div className="panel">
            <div className="panel-head"><h3>BOMs ({bomTotal})</h3></div>
            <form
              className="row"
              style={{ gap: 8, marginBottom: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                loadBoms();
              }}
            >
              <input
                placeholder="Search key or name"
                value={bomQuery}
                onChange={(e) => setBomQuery(e.target.value)}
              />
              <select
                value={bomTypeFilter}
                onChange={(e) => setBomTypeFilter(e.target.value)}
              >
                <option value="">All types</option>
                {bomTypeCodes.map((code) => (
                  <option key={code} value={code}>{code}</option>
                ))}
              </select>
              <button className="btn ghost" disabled={busy}>Search</button>
            </form>
            <BomTable
              boms={boms}
              onSelect={selectBom}
              selectedId={selectedBom?.id}
            />
          </div>

          <div className="panel">
            <div className="panel-head"><h3>BOM detail</h3></div>
            {!selectedBom ? (
              <p className="subtle">Select a BOM to inspect it.</p>
            ) : (
              <ul className="detail-list">
                <li>ID: {selectedBom.id}</li>
                <li>Key: {selectedBom.bom_key}</li>
                <li>Type: <span className="mono">{selectedBom.bom_type}</span></li>
                <li>Name: {selectedBom.name || "-"}</li>
                <li>Root item: {selectedBom.root_item_id ?? "-"}</li>
                <li>Root revision: {selectedBom.root_revision_id ?? "-"}</li>
                <li>Lifecycle: <Badge value={selectedBom.lifecycle_status} /></li>
                <li>Graph entity: {selectedBom.graph_entity_id ?? "-"}</li>
              </ul>
            )}
          </div>
        </div>
      ) : null}

      {tab === "Structure" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Structure {selectedBom ? `- ${selectedBom.bom_key}` : ""}</h3>
          </div>
          {!selectedBom ? (
            <p className="subtle">Select a BOM on the BOMs tab first.</p>
          ) : (
            <>
              <div className="row" style={{ gap: 8, marginBottom: 12 }}>
                <label className="muted">Max depth</label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={structureDepth}
                  onChange={(e) => setStructureDepth(e.target.value)}
                  style={{ width: 80 }}
                />
                <button className="btn" onClick={loadStructure} disabled={busy}>
                  Expand
                </button>
              </div>
              {structure ? (
                <>
                  <div className="row" style={{ gap: 16, marginBottom: 8 }}>
                    <span className="muted">Rows: <strong>{structure.total}</strong></span>
                    <span className="muted">Depth: <strong>{structure.max_depth_reached}</strong></span>
                    {structure.truncated ? <span className="badge pending">truncated</span> : null}
                    {structure.cycle_detected ? <span className="badge deprecated">cycle</span> : null}
                  </div>
                  <StructureTable rows={structure.rows} />
                </>
              ) : (
                <p className="subtle">Expand to view structure.</p>
              )}
            </>
          )}
        </div>
      ) : null}

      {tab === "Compare" ? (
        <div className="panel">
          <div className="panel-head"><h3>BOM comparison</h3></div>
          <form className="row" style={{ gap: 8, marginBottom: 12 }} onSubmit={runComparison}>
            <input
              placeholder="Left BOM id"
              value={leftHeader}
              onChange={(e) => setLeftHeader(e.target.value)}
              style={{ width: 120 }}
            />
            <input
              placeholder="Right BOM id"
              value={rightHeader}
              onChange={(e) => setRightHeader(e.target.value)}
              style={{ width: 120 }}
            />
            <button className="btn" disabled={busy}>Run comparison</button>
          </form>
          {comparison ? (
            <>
              <div className="row" style={{ gap: 16, marginBottom: 8 }}>
                <span className="muted">Added: <strong>{comparison.summary.added}</strong></span>
                <span className="muted">Removed: <strong>{comparison.summary.removed}</strong></span>
                <span className="muted">Modified: <strong>{comparison.summary.modified}</strong></span>
                <span className="muted">Moved: <strong>{comparison.summary.moved}</strong></span>
              </div>
              <DiffTable diffs={comparison.diffs} />
            </>
          ) : (
            <p className="subtle">Enter two BOM ids and compare.</p>
          )}
        </div>
      ) : null}

      {tab === "Intelligence" ? (
        <div className="stack">
          <div className="panel">
            <div className="panel-head">
              <h3>Reuse analysis</h3>
              <button className="btn ghost" onClick={loadReuse} disabled={busy}>Load</button>
            </div>
            {reuse ? <IntelligenceTable rows={reuse.rows} /> : <p className="subtle">Load reuse analysis.</p>}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Duplicate candidates</h3>
              <button className="btn ghost" onClick={loadDuplicates} disabled={busy}>Load</button>
            </div>
            {duplicates ? (
              <>
                <div className="row" style={{ gap: 16, marginBottom: 8 }}>
                  <span className="muted">Exact: <strong>{duplicates.summary.exact}</strong></span>
                  <span className="muted">Similar: <strong>{duplicates.summary.similar}</strong></span>
                </div>
                <IntelligenceTable rows={duplicates.rows} />
              </>
            ) : (
              <p className="subtle">Load duplicate candidates.</p>
            )}
          </div>

          <div className="panel">
            <div className="panel-head"><h3>Where-used</h3></div>
            <form className="row" style={{ gap: 8, marginBottom: 12 }} onSubmit={runWhereUsed}>
              <input
                placeholder="Item id"
                value={whereUsedItem}
                onChange={(e) => setWhereUsedItem(e.target.value)}
                style={{ width: 120 }}
              />
              <button className="btn" disabled={busy}>Find</button>
            </form>
            {whereUsed ? <IntelligenceTable rows={whereUsed.rows} /> : <p className="subtle">Enter an item id.</p>}
          </div>
        </div>
      ) : null}

      {tab === "Quality" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>BOM quality {selectedBom ? `- ${selectedBom.bom_key}` : ""}</h3>
            <button className="btn ghost" onClick={loadQuality} disabled={busy || !selectedBom}>
              Check
            </button>
          </div>
          {!selectedBom ? (
            <p className="subtle">Select a BOM on the BOMs tab first.</p>
          ) : quality ? (
            <>
              <div className="row" style={{ gap: 16, marginBottom: 8 }}>
                <span className="muted">Status: <Badge value={quality.status} /></span>
                <span className="muted">Score: <strong>{quality.score}</strong></span>
                <span className="muted">Errors: <strong>{quality.summary.errors}</strong></span>
                <span className="muted">Warnings: <strong>{quality.summary.warnings}</strong></span>
              </div>
              {!quality.issues?.length ? (
                <p className="subtle">No issues.</p>
              ) : (
                <ul className="detail-list">
                  {quality.issues.map((issue, index) => (
                    <li key={`${issue.rule}-${index}`}>
                      <Badge value={issue.severity} />{" "}
                      <span className="mono">{issue.rule}</span>{" "}
                      <span>{issue.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="subtle">Run a quality check.</p>
          )}
        </div>
      ) : null}

      {tab === "Change impact" ? (
        <div className="panel">
          <div className="panel-head"><h3>Change impact</h3></div>
          <form className="row" style={{ gap: 8, marginBottom: 12 }} onSubmit={runImpact}>
            <input
              placeholder="Change entity id"
              value={changeEntity}
              onChange={(e) => setChangeEntity(e.target.value)}
              style={{ width: 160 }}
            />
            <button className="btn" disabled={busy}>Analyze</button>
          </form>
          {impact ? (
            <>
              <div className="row" style={{ gap: 16, marginBottom: 8 }}>
                <span className="muted">Affected items: <strong>{impact.affected_items.length}</strong></span>
                <span className="muted">Affected BOMs: <strong>{impact.affected_boms.length}</strong></span>
                {impact.inferred ? <span className="badge pending">inferred</span> : null}
                {impact.truncated ? <span className="badge pending">truncated</span> : null}
              </div>
              <IntelligenceTable rows={[...impact.affected_items, ...impact.affected_boms]} />
            </>
          ) : (
            <p className="subtle">Enter a change entity id.</p>
          )}
        </div>
      ) : null}
    </>
  );
}
