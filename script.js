// Seating Generator v4 (mode-free UX)
// - Click/drag over empty cells => add seats; click/drag starting on a seat => remove seats
// - Drag & drop swaps/moves students (teacher view)
// - Colour tool: click/drag over tables to give them a group colour
// - Resizing the grid keeps existing seats (rows/cols are added/removed at the bottom/right)
// - Updating names keeps the published seating and seats new names in free seats
// - Restrictions: PAIR, GAP, MUST_DIRECT, FIXED_SEAT ("Specific seat")
// - FIXED_SEAT students are pre-placed in teacher view only (draft preview)
// - Generate publishes a seating chart to student view
// - Changing names or restrictions clears the published seating
// - Generation prefers fewer "lonely" students if possible

// All classes live under STORE_KEY (see loadStore). STORAGE_KEY is the older
// single-class format, only read once to migrate it.
const STORE_KEY = "seating_generator_classes_v1";
const STORAGE_KEY = "seating_generator_v4";
const BACKUP_APP_ID = "seating-generator";

// Table group colours: fill for the seat, strong colour for its border.
// Fills must stay clearly distinct from white on any screen (very pale blue/purple
// tints read as white), while keeping black names readable.
const TABLE_COLORS = {
  red:    { label: "Red",    fill: "#fecaca", stroke: "#b91c1c" },
  orange: { label: "Orange", fill: "#fed7aa", stroke: "#c2410c" },
  yellow: { label: "Yellow", fill: "#fde68a", stroke: "#a16207" },
  green:  { label: "Green",  fill: "#bbf7d0", stroke: "#15803d" },
  blue:   { label: "Blue",   fill: "#bfdbfe", stroke: "#1d4ed8" },
  purple: { label: "Purple", fill: "#ddd6fe", stroke: "#6d28d9" },
  pink:   { label: "Pink",   fill: "#fbcfe8", stroke: "#be185d" },
  grey:   { label: "Grey",   fill: "#d1d5db", stroke: "#374151" }
};

// -------------------------
// DOM
// -------------------------

const teacherView = document.getElementById("teacherView");
const studentView = document.getElementById("studentView");

const btnToggleMode = document.getElementById("btnToggleMode");
const btnGenerate = document.getElementById("btnGenerate");
const btnBuildLayout = document.getElementById("btnBuildLayout");
const btnSave = document.getElementById("btnSave");

const classSelect = document.getElementById("classSelect");
const btnNewClass = document.getElementById("btnNewClass");
const btnDeleteClass = document.getElementById("btnDeleteClass");
const roomSelect = document.getElementById("roomSelect");
const roomNameInput = document.getElementById("roomNameInput");
const btnNewRoom = document.getElementById("btnNewRoom");
const btnDeleteRoom = document.getElementById("btnDeleteRoom");
const layoutRoomNameEl = document.getElementById("layoutRoomName");
const btnExport = document.getElementById("btnExport");
const btnExportAll = document.getElementById("btnExportAll");
const btnImport = document.getElementById("btnImport");
const importFile = document.getElementById("importFile");

const namesMessages = document.getElementById("namesMessages");
const attendanceList = document.getElementById("attendanceList");
const btnAllPresent = document.getElementById("btnAllPresent");

const btnAddRestriction = document.getElementById("btnAddRestriction");
const btnClearRestrictions = document.getElementById("btnClearRestrictions");
const restrictionsList = document.getElementById("restrictionsList");

const btnDownloadPng = document.getElementById("btnDownloadPng");
const btnFlipView = document.getElementById("btnFlipView");
const tabSeating = document.getElementById("tabSeating");
const tabGroups = document.getElementById("tabGroups");
const groupsView = document.getElementById("groupsView");

const groupValueInput = document.getElementById("groupValueInput");
const groupModeSelect = document.getElementById("groupModeSelect");
const groupSizePreview = document.getElementById("groupSizePreview");
const groupUseSeatingInput = document.getElementById("groupUseSeatingInput");
const btnAddGroupRule = document.getElementById("btnAddGroupRule");
const btnGenerateGroups = document.getElementById("btnGenerateGroups");
const groupRulesList = document.getElementById("groupRulesList");
const groupsPreview = document.getElementById("groupsPreview");

const namesInput = document.getElementById("namesInput");
const rowsInput = document.getElementById("rowsInput");
const colsInput = document.getElementById("colsInput");
const seatEditor = document.getElementById("seatEditor");
const seatingGrid = document.getElementById("seatingGrid");
const pinInput = document.getElementById("pinInput");
const chartNameInput = document.getElementById("chartNameInput");
const showColorsInput = document.getElementById("showColorsInput");
const toolBar = document.getElementById("toolBar");
const toolHint = document.getElementById("toolHint");
const chartTitleEl = document.getElementById("chartTitle");
const statusEl = document.getElementById("status");

const seatCountEl = document.getElementById("seatCount");
const studentCountEl = document.getElementById("studentCount");



// -------------------------
// State
// -------------------------

let isStudentView = false;
let studentViewFlipped = false;

let layout = {
  rows: 7,
  cols: 10,
  exists: [] // boolean array rows*cols
};

let studentNames = [];   // parsed from textarea (applied on change, see refreshNamesFromTextarea)
let restrictions = [];   // array of {a,b,type}

// Students marked absent. They keep their restrictions and pins but aren't seated.
let absentStudents = new Set();

// Every class's saved data: { currentId, teacherPin, classes: [{ id, data }] }, where
// data is what saveSetup builds. See loadStore/saveSetup.
let store = null;



// Published seating shown to students
let publishedAssignment = []; // length rows*cols, "" if none

// Fixed seat assignments: seatIndex -> studentName (only for FIXED_SEAT students)
let fixedStudentBySeat = [];  // length rows*cols, "" if none

// Table group colour per seat: seatIndex -> TABLE_COLORS key, "" if none.
// Stored per seat; normalizeTableColors() keeps every seat of a table the same colour.
let tableColorBySeat = [];    // length rows*cols

// Teacher editor tool: "seats" (add/remove seats), a TABLE_COLORS key, or "none" (remove colour)
let activeTool = "seats";

// Ongoing click-and-drag in the seat editor (see startPaint), null when idle
let paint = null;

// Groups (e.g. for a project), per class. groupRules are separate from the seating
// restrictions; groups holds the latest generated groups (arrays of names).
let groupRules = [];      // [{ a, b, type: "APART" | "TOGETHER" }]
let groupSettings = { mode: "size", value: 4, useSeatingRules: true };
let groups = [];

// Which Student View tab is showing: "seating" or "groups"
let studentTab = "seating";

// Interval of the running group shuffle animation, null when idle
let groupAnimation = null;

// -------------------------
// Helpers
// -------------------------

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

function normalizeName(name) {
  return name.trim();
}

function parseNames(text) {
  const names = text
    .split("\n")
    .map(normalizeName)
    .filter(n => n.length > 0);

  const seen = new Set();
  const out = [];
  for (const n of names) {
    const key = n.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(n);
    }
  }
  return out;
}

function findDuplicateNames(text) {
  // Names that appear more than once (case-insensitive) -> [{ name, lines: [1-based] }].
  // parseNames keeps only the first, so these students would silently be missing.
  const byKey = new Map();
  text.split("\n").forEach((line, k) => {
    const name = normalizeName(line);
    if (!name) return;
    const key = name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, { name, lines: [] });
    byKey.get(key).lines.push(k + 1);
  });
  return Array.from(byKey.values()).filter(d => d.lines.length > 1);
}

function presentStudents() {
  return studentNames.filter(n => !absentStudents.has(n));
}

const FIRST_NAME_HEADER = /^(first ?name|given ?name|förnamn|fornamn|tilltalsnamn)$/i;
const LAST_NAME_HEADER = /^(last ?name|surname|family ?name|efternamn)$/i;

function cleanPastedNames(text) {
  // Tidy a pasted class list. Returns { text, changes: [description] }.
  // - Spreadsheet/CSV rows (tab, ";" or 2+ "," separated): drop number/email cells and
  //   join the rest. A "First name"/"Last name" header row picks the name columns
  //   (kept in the sheet's order) and is itself dropped.
  // - Numbering and bullets ("1.", "2)", "-", "•") are removed.
  // Name order is never changed.
  const changes = new Set();
  const lines = text.split(/\r?\n/);
  const out = [];
  let nameCols = null; // column indices from a header row, in sheet order

  const isColumnRow = (line) => /[\t;]/.test(line) || (line.match(/,/g) || []).length >= 2;
  const splitCells = (line) => line.split(/[\t;,]/).map(s => s.trim());

  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;

    if (isColumnRow(line)) {
      const cells = splitCells(line);
      const headerCols = cells
        .map((c, k) => (FIRST_NAME_HEADER.test(c) || LAST_NAME_HEADER.test(c)) ? k : -1)
        .filter(k => k !== -1);
      if (headerCols.length > 0) {
        // Header row: remember the name columns, don't keep the row
        nameCols = headerCols;
        changes.add("removed the header row");
        continue;
      }

      if (nameCols) {
        line = nameCols.map(k => cells[k] || "").join(" ");
      } else {
        const kept = cells.filter(c => c && !/^[\d\s.\-\/:]+$/.test(c) && !c.includes("@"));
        if (kept.length !== cells.filter(Boolean).length) changes.add("dropped number/email columns");
        line = kept.join(" ");
      }
      changes.add("joined spreadsheet columns into one name");
    }

    const unnumbered = line.replace(/^(\d+\s*[.):\-]\s*|\d+\s+|[-•*·]\s+)/, "");
    if (unnumbered !== line) {
      changes.add("removed numbering");
      line = unnumbered;
    }

    line = line.replace(/\s+/g, " ").trim();
    if (line) out.push(line);
  }

  return { text: out.join("\n"), changes: Array.from(changes) };
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

function indexToRC(index, cols) {
  return { r: Math.floor(index / cols), c: index % cols };
}

function rcToIndex(r, c, cols) {
  return r * cols + c;
}

function seatPreferenceScore(seatIdx) {
  // Higher is better.
  // Priority: further up (smaller row) and closer to the middle.
  const { r, c } = indexToRC(seatIdx, layout.cols);
  const mid = (layout.cols - 1) / 2;
  const distMid = Math.abs(c - mid);

  // Big weight on row so "further up" wins ties, then middle.
  // (Negative r because smaller r is better.)
  return (-r * 100) - distMid;
}

function colorForComponent(compId) {
  // Stable-ish, readable palette. (Teacher view only.)
  const palette = [
    "#2563eb", "#16a34a", "#dc2626", "#7c3aed",
    "#0f766e", "#ea580c", "#0891b2", "#9333ea"
  ];
  return palette[Math.abs(compId) % palette.length];
}

function pickSeatSubset(seatsToFill, count, directAdj, componentId, alreadyUsedInComponent, attempt) {
  // We need to choose which seats get assigned when there are more seats than students.
  // New goal (cluster-based):
  //  - Prefer seats further up and near the middle
  //  - Avoid "lonely" used clusters: if a seat cluster is used at all, try to use >= 2 seats
  //    in that cluster (unless it's impossible).
  //
  // Note:
  //  - "Cluster" means connected component under orthogonal adjacency (same as directAdj).
  //  - alreadyUsedInComponent counts pinned seats already placed in solveOnce.

  if (count <= 0) return [];
  if (count >= seatsToFill.length) return seatsToFill.slice();

  const preferred = seatsToFill.slice().sort((a, b) => seatPreferenceScore(b) - seatPreferenceScore(a));
  const selected = new Set();

  // Per-component bookkeeping
  const compAvail = new Map();
  const compSelected = new Map();
  for (const idx of seatsToFill) {
    const cid = componentId[idx];
    if (cid === -1) continue;
    if (!compAvail.has(cid)) compAvail.set(cid, []);
    compAvail.get(cid).push(idx);
  }
  for (const [cid, list] of compAvail.entries()) {
    list.sort((a, b) => seatPreferenceScore(b) - seatPreferenceScore(a));
    compSelected.set(cid, 0);
  }

  const jitter = (attempt || 0) % 9;

  function totalUsedInComp(cid) {
    return (alreadyUsedInComponent.get(cid) || 0) + (compSelected.get(cid) || 0);
  }

  function addSeat(idx) {
    if (selected.has(idx)) return;
    selected.add(idx);
    const cid = componentId[idx];
    if (cid !== -1) compSelected.set(cid, (compSelected.get(cid) || 0) + 1);
  }

  // 1) If any component already has exactly one pinned student, try to add one more seat there first.
  //    (This directly matches the "no one sits alone in a used cluster" intent.)
  const compIds = Array.from(compAvail.keys());
  compIds.sort((a, b) => (seatPreferenceScore(compAvail.get(b)[0]) - seatPreferenceScore(compAvail.get(a)[0])));

  for (const cid of compIds) {
    if (selected.size >= count) break;
    const used = totalUsedInComp(cid);
    if (used !== 1) continue;

    const candidates = compAvail.get(cid) || [];
    // Pick best available seat in that component.
    for (const idx of candidates) {
      if (selected.has(idx)) continue;
      addSeat(idx);
      break;
    }
  }

  // 2) Add seats in PAIRS within the same component when possible.
  //    This keeps clusters from ending up with a single student.
  function bestPairInComponent(cid) {
    const list = compAvail.get(cid) || [];
    let best = null;
    let bestScore = -Infinity;

    // Consider only a small prefix for performance / predictability.
    const consider = Math.min(list.length, 10 + jitter * 2);
    for (let i = 0; i < consider; i++) {
      const a = list[i];
      if (selected.has(a)) continue;
      for (let j = i + 1; j < consider; j++) {
        const b = list[j];
        if (selected.has(b)) continue;

        // Prefer actual direct neighbors, but allow any two seats in the same component.
        const neighborBonus = (directAdj.get(a) || []).includes(b) ? 60 : 0;
        const score = seatPreferenceScore(a) + seatPreferenceScore(b) + neighborBonus;
        if (score > bestScore) {
          bestScore = score;
          best = [a, b];
        }
      }
    }
    return best;
  }

  while (selected.size + 1 < count) {
    // Find the best pair among all components.
    let bestPair = null;
    let bestScore = -Infinity;

    for (const cid of compIds) {
      const pair = bestPairInComponent(cid);
      if (!pair) continue;
      const score = seatPreferenceScore(pair[0]) + seatPreferenceScore(pair[1]);
      if (score > bestScore) {
        bestScore = score;
        bestPair = pair;
      }
    }

    if (!bestPair) break;

    addSeat(bestPair[0]);
    if (selected.size < count) addSeat(bestPair[1]);
  }

  // 3) If we still need one seat (odd count), try to add it to a component that will not become lonely.
  if (selected.size < count) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    const considerN = Math.min(preferred.length, 20 + jitter * 3);
    for (let i = 0; i < considerN; i++) {
      const idx = preferred[i];
      if (selected.has(idx)) continue;

      const cid = componentId[idx];
      const usedBefore = (cid === -1) ? 0 : totalUsedInComp(cid);

      // We don't want to start a new used component with exactly 1 seat if we can avoid it.
      // So we prefer seats where usedBefore >= 1 (so adding this yields >=2), or components
      // that are singletons anyway.
      let penalty = 0;
      if (cid !== -1) {
        const availCount = (compAvail.get(cid) || []).length + (alreadyUsedInComponent.get(cid) || 0);
        const isSingletonComponent = (availCount <= 1);
        if (!isSingletonComponent && usedBefore === 0) penalty = 250;
      }

      const score = seatPreferenceScore(idx) - penalty;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }

    if (bestIdx === -1) {
      for (const idx of preferred) {
        if (!selected.has(idx)) {
          bestIdx = idx;
          break;
        }
      }
    }

    addSeat(bestIdx);
  }

  // 4) Final cleanup: if we ended up with a lonely used component and we still have slack,
  //    try a small swap to fix it.
  //    This only runs in the "more seats than students" case, so it can't make things worse.
  //
  //    Lonely used component = used seats in component is exactly 1, but component has >=2 seats.
  const selectedArr = Array.from(selected);
  const selectedSet = new Set(selectedArr);

  function componentTotalSeats(cid) {
    const avail = (compAvail.get(cid) || []).length;
    const pinned = (alreadyUsedInComponent.get(cid) || 0);
    return avail + pinned;
  }

  function findLonelySelectedSeat() {
    for (const idx of selectedArr) {
      const cid = componentId[idx];
      if (cid === -1) continue;
      if (componentTotalSeats(cid) < 2) continue;
      if (totalUsedInComp(cid) === 1) return idx;
    }
    return -1;
  }

  // One swap attempt is usually enough.
  const lonelySeat = findLonelySelectedSeat();
  if (lonelySeat !== -1) {
    const lonelyCid = componentId[lonelySeat];

    // Find a replacement seat from a component that already has >= 1 used (or is singleton).
    let replacement = -1;
    let best = -Infinity;
    for (const idx of preferred) {
      if (selectedSet.has(idx)) continue;
      const cid = componentId[idx];
      if (cid === -1) continue;

      const totalSeats = componentTotalSeats(cid);
      const usedBefore = totalUsedInComp(cid);
      const singleton = totalSeats <= 1;

      if (!singleton && usedBefore === 0) continue; // would create a new lonely cluster
      const score = seatPreferenceScore(idx);
      if (score > best) {
        best = score;
        replacement = idx;
      }
    }

    if (replacement !== -1) {
      selected.delete(lonelySeat);
      selected.add(replacement);
    }
  }

  return Array.from(selected);
}

function ensureClusterOverlaySvg(containerEl) {
  let svg = containerEl.querySelector(".cluster-overlay");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("cluster-overlay");
    svg.setAttribute("aria-hidden", "true");
    containerEl.appendChild(svg);
  }
  return svg;
}

/**
 * Draw cluster outlines with a thin black border, aligned using real DOM rects.
 *
 * Inputs:
 * - containerEl: the grid container that contains the seat cells
 * - componentId: array where componentId[seatIndex] = cluster id
 * - getSeatElementByIndex: function (idx) => DOM element for that seat
 *
 * Notes:
 * - This avoids drift by using getBoundingClientRect relative to the container.
 * - You must be able to access the seat element for a given seat index.
 */
function drawClusterOutlinesSvg(containerEl, componentId, getSeatElementByIndex) {
  const svg = ensureClusterOverlaySvg(containerEl);
  svg.innerHTML = "";

  const gridRect = containerEl.getBoundingClientRect();

  // IMPORTANT: subtract border thickness so coordinates match the content box
  const originX = containerEl.clientLeft;
  const originY = containerEl.clientTop;

  function rectRelativeToContainer(el) {
    const r = el.getBoundingClientRect();
    return {
      x: (r.left - gridRect.left) - originX,
      y: (r.top - gridRect.top) - originY,
      w: r.width,
      h: r.height
    };
  }

  // Build components -> list of {r,c}
  const byComp = new Map();
  for (let idx = 0; idx < componentId.length; idx++) {
    const cid = componentId[idx];
    if (cid == null || cid === -1) continue;

    const seatEl = getSeatElementByIndex(idx);
    if (!seatEl) continue;              // safety
    if (seatEl.classList.contains("empty")) continue;

    if (!byComp.has(cid)) byComp.set(cid, []);
    const r = Math.floor(idx / layout.cols);
    const c = idx % layout.cols;
    byComp.get(cid).push({ r, c });
  }

    // --- Stable grid mapping (prevents "jumping" when you add/remove seats) ---

  // Find a reference (non-empty) seat to measure cell size and infer the grid origin.
  let refEl = null;
  let refIdx = -1;

  for (let idx = 0; idx < componentId.length; idx++) {
    const seatEl = getSeatElementByIndex(idx);
    if (!seatEl) continue;
    if (seatEl.classList.contains("empty")) continue;
    refEl = seatEl;
    refIdx = idx;
    break;
  }

  if (!refEl) return; // nothing to draw

  const refRect = rectRelativeToContainer(refEl);
  const refRow = Math.floor(refIdx / layout.cols);
  const refCol = refIdx % layout.cols;

  // Read actual CSS grid gaps. (.seat-grid uses gap: 8px)
  const cs = getComputedStyle(containerEl);
  const gapX = parseFloat(cs.columnGap || cs.gap || "0") || 0;
  const gapY = parseFloat(cs.rowGap || cs.gap || "0") || 0;

  const cellW = refRect.w;
  const cellH = refRect.h;

  const stepX = cellW + gapX;
  const stepY = cellH + gapY;

  // Infer where col 0 / row 0 starts inside this container (content-box coords)
  const left0 = refRect.x - refCol * stepX;
  const top0  = refRect.y - refRow * stepY;

  // Grid line x sits before column x; shift back by half a gap so the outline runs
  // through the middle of the gap around a table. The outer edges land just outside the
  // container, so .cluster-overlay has overflow: visible.
  function xEdge(x) {
    return left0 + x * stepX - gapX / 2;
  }

  function yEdge(y) {
    return top0 + y * stepY - gapY / 2;
  }

  const width = containerEl.clientWidth;
  const height = containerEl.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");

  // Draw paths (thin black)
  for (const [cid, cells] of byComp.entries()) {
    const loops = buildComponentOutlineLoops(cells);

    for (const loop of loops) {
      if (!loop || loop.length < 3) continue;

      let d = "";
      for (let i = 0; i < loop.length; i++) {
        const p = loop[i];
        const x = xEdge(p.x);
        const y = yEdge(p.y);
        d += (i === 0) ? `M ${x} ${y}` : ` L ${x} ${y}`;
      }
      d += " Z";

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "#111");
      path.setAttribute("stroke-width", "2");        // thinner black border
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("stroke-linecap", "round");
      svg.appendChild(path);
    }
  }
}

function buildComponentOutlineLoops(componentCells) {
  // componentCells: array of {r,c} grid coordinates.
  // We build the perimeter as loops of integer grid points.

  const cellSet = new Set(componentCells.map(p => `${p.r},${p.c}`));
  const segments = []; // each: [x1,y1,x2,y2] in grid-units

  function hasCell(r, c) {
    return cellSet.has(`${r},${c}`);
  }

  for (const { r, c } of componentCells) {
    // Top edge
    if (!hasCell(r - 1, c)) segments.push([c, r, c + 1, r]);
    // Bottom
    if (!hasCell(r + 1, c)) segments.push([c, r + 1, c + 1, r + 1]);
    // Left
    if (!hasCell(r, c - 1)) segments.push([c, r, c, r + 1]);
    // Right
    if (!hasCell(r, c + 1)) segments.push([c + 1, r, c + 1, r + 1]);
  }

  // Build adjacency from segments
  const nextByPoint = new Map(); // "x,y" -> array of {x,y}
  const unused = new Set();

  function pkey(x, y) {
    return `${x},${y}`;
  }

  function ekey(x1, y1, x2, y2) {
    return `${x1},${y1}|${x2},${y2}`;
  }

  for (const [x1, y1, x2, y2] of segments) {
    const a = pkey(x1, y1);
    const b = pkey(x2, y2);
    if (!nextByPoint.has(a)) nextByPoint.set(a, []);
    if (!nextByPoint.has(b)) nextByPoint.set(b, []);
    nextByPoint.get(a).push({ x: x2, y: y2 });
    nextByPoint.get(b).push({ x: x1, y: y1 });
    unused.add(ekey(x1, y1, x2, y2));
    unused.add(ekey(x2, y2, x1, y1));
  }

  const loops = [];

  while (unused.size > 0) {
    // Pick any unused directed edge as a starting point
    const first = unused.values().next().value;
    const [aStr, bStr] = first.split("|");
    const [sx, sy] = aStr.split(",").map(Number);
    const [nx, ny] = bStr.split(",").map(Number);

    const loop = [{ x: sx, y: sy }];
    let prev = { x: sx, y: sy };
    let cur = { x: nx, y: ny };
    unused.delete(first);

    // Walk until we return to start
    const guardMax = segments.length * 4 + 20;
    let guard = 0;
    while (guard++ < guardMax) {
      loop.push({ x: cur.x, y: cur.y });
      if (cur.x === sx && cur.y === sy) break;

      const options = nextByPoint.get(pkey(cur.x, cur.y)) || [];
      // Choose the next point that continues an unused edge.
      let chosen = null;
      for (const opt of options) {
        if (opt.x === prev.x && opt.y === prev.y) continue;
        const k = ekey(cur.x, cur.y, opt.x, opt.y);
        if (unused.has(k)) {
          chosen = opt;
          break;
        }
      }

      // Fallback: allow going back if it's the only way.
      if (!chosen) {
        for (const opt of options) {
          const k = ekey(cur.x, cur.y, opt.x, opt.y);
          if (unused.has(k)) {
            chosen = opt;
            break;
          }
        }
      }

      if (!chosen) break;

      const usedKey = ekey(cur.x, cur.y, chosen.x, chosen.y);
      unused.delete(usedKey);
      prev = cur;
      cur = { x: chosen.x, y: chosen.y };
    }

    if (loop.length >= 4) loops.push(loop);
  }

  return loops;
}

function drawTeacherClusterOutlines(containerEl, pairAdj, componentId) {
  // Draw outlines for connected components of seats (orthogonal adjacency).
  // Uses an SVG overlay so outlines can bridge grid gaps cleanly.

  function getSeatElementByIndex(idx) {
    return containerEl.querySelector(`[data-index="${idx}"]`);
  }

  drawClusterOutlinesSvg(containerEl, componentId, getSeatElementByIndex);
  return;
  // Remove old overlay paths
  const svg = ensureClusterOverlaySvg(containerEl);
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // Determine geometry using the actual DOM positions.
  // This avoids subtle drift where the SVG path can end up slightly down/right
  // compared to the seats (browser rounding, scaling, etc.).
  const style = window.getComputedStyle(containerEl);
  const gap = parseFloat(style.gap || style.columnGap || "0") || 0;

  const anyCell = containerEl.querySelector(".seat");
  if (!anyCell) return;

  // Use offset-based measurements so everything is in the container's coordinate space.
  const cellW = anyCell.offsetWidth;
  const cellH = anyCell.offsetHeight;

  function cellElAt(r, c) {
    const idx = rcToIndex(r, c, layout.cols);
    return containerEl.querySelector(`[data-index="${idx}"]`);
  }

  const cell00 = cellElAt(0, 0) || anyCell;
  const originX = cell00.offsetLeft;
  const originY = cell00.offsetTop;

  // Prefer measured deltas between neighboring cells if possible.
  let unitX = cellW + gap;
  let unitY = cellH + gap;

  if (layout.cols > 1) {
    const cell01 = cellElAt(0, 1);
    if (cell01) unitX = cell01.offsetLeft - cell00.offsetLeft;
  }

  if (layout.rows > 1) {
    const cell10 = cellElAt(1, 0);
    if (cell10) unitY = cell10.offsetTop - cell00.offsetTop;
  }

  // Use the container's actual pixel size for the SVG coordinate space.
  const width = containerEl.clientWidth;
  const height = containerEl.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");

  // Build components -> list of cells
  const byComp = new Map();
  for (let i = 0; i < layout.exists.length; i++) {
    if (!layout.exists[i]) continue;
    const cid = componentId[i];
    if (cid === -1) continue;
    if (!byComp.has(cid)) byComp.set(cid, []);
    const { r, c } = indexToRC(i, layout.cols);
    byComp.get(cid).push({ r, c });
  }

  for (const [cid, cells] of byComp.entries()) {
    const loops = buildComponentOutlineLoops(cells);

    const isIsolated = (cells.length === 1) && ((pairAdj.get(rcToIndex(cells[0].r, cells[0].c, layout.cols)) || []).length === 0);

    for (const loop of loops) {
      let d = "";
      for (let k = 0; k < loop.length; k++) {
        const p = loop[k];
        // Convert grid-unit corner points to pixel coordinates.
        // Note: corners are at cell boundaries, so (p.x, p.y) refers to the boundary
        // before column p.x / row p.y.
        const x = originX + p.x * unitX;
        const y = originY + p.y * unitY;
        d += (k === 0) ? `M ${x} ${y}` : ` L ${x} ${y}`;
      }
      d += " Z";

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      // User preference: a subtle, consistent black border (not one color per table).
      path.setAttribute("stroke", "#111");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("opacity", "0.75");
      if (isIsolated) path.setAttribute("stroke-dasharray", "6 6");
      svg.appendChild(path);
    }
  }
}

function edgeKey(i, j) {
  return i < j ? `${i}|${j}` : `${j}|${i}`;
}

function namePairKey(a, b) {
  const aa = a.trim();
  const bb = b.trim();
  if (aa.toLowerCase() < bb.toLowerCase()) return `${aa}|${bb}`;
  return `${bb}|${aa}`;
}

function ensureParallelArrays() {
  const n = layout.exists.length;
  if (!Array.isArray(publishedAssignment) || publishedAssignment.length !== n) {
    publishedAssignment = new Array(n).fill("");
  }
  if (!Array.isArray(fixedStudentBySeat) || fixedStudentBySeat.length !== n) {
    fixedStudentBySeat = new Array(n).fill("");
  }
  if (!Array.isArray(tableColorBySeat) || tableColorBySeat.length !== n) {
    tableColorBySeat = new Array(n).fill("");
  }
}

function updateCounts() {
  // Live from the textarea (names apply on change, but the counts and warnings
  // follow typing), plus the attendance list.
  const seatCount = layout.exists.filter(x => x).length;
  const typedNames = parseNames(namesInput.value);
  const absentCount = typedNames.filter(n => absentStudents.has(n)).length;

  seatCountEl.textContent = String(seatCount);
  studentCountEl.textContent = absentCount
    ? `${typedNames.length - absentCount} (+${absentCount} absent)`
    : String(typedNames.length);

  renderNameMessages();
  renderAttendance();
  updateGroupSizePreview();
}

function renderNameMessages(pasteNote) {
  // Duplicate warnings, and (right after a paste) what the paste cleanup changed
  namesMessages.innerHTML = "";

  if (pasteNote) {
    const p = document.createElement("p");
    p.className = "names-note";
    p.textContent = pasteNote;
    namesMessages.appendChild(p);
  }

  for (const dup of findDuplicateNames(namesInput.value)) {
    const p = document.createElement("p");
    p.className = "names-warning";
    const lines = dup.lines.slice(0, -1).join(", ") + " and " + dup.lines[dup.lines.length - 1];
    p.textContent = `"${dup.name}" is on lines ${lines}, so only one of them is seated. ` +
      `Add an initial or surname to tell them apart (e.g. "${dup.name} A").`;
    namesMessages.appendChild(p);
  }
}

function renderAttendance() {
  attendanceList.innerHTML = "";
  for (const name of studentNames) {
    const btn = document.createElement("button");
    btn.type = "button";
    const absent = absentStudents.has(name);
    btn.className = "attendance-chip" + (absent ? " absent" : "");
    btn.textContent = name;
    btn.title = absent ? `${name} is absent: click to mark present` : `Click to mark ${name} absent`;
    btn.setAttribute("aria-pressed", String(absent));
    btn.addEventListener("click", () => setAbsent([name], !absent));
    attendanceList.appendChild(btn);
  }
  btnAllPresent.disabled = absentStudents.size === 0;
}

function setAbsent(names, absent) {
  // Marking absent frees the student's seat; marking present seats them in a free seat.
  // The rest of a published seating is kept either way.
  const previouslyPresent = presentStudents();
  for (const n of names) {
    if (absent) absentStudents.add(n);
    else absentStudents.delete(n);
  }

  let msg = absent
    ? `${names.join(", ")} marked absent.`
    : (names.length === 1 ? `${names[0]} marked present.` : "Everyone marked present.");
  if (anyPublishedSeating()) msg += " " + syncPublishedWithPresent(previouslyPresent);
  const groupsMsg = syncGroupsWithPresent(previouslyPresent);
  if (groupsMsg) msg += " " + groupsMsg;
  renderGroups();

  updateCounts();
  renderSeatEditor();
  renderStudentView();
  saveSetup();
  setStatus(msg);
}

function anyPublishedSeating() {
  if (!Array.isArray(publishedAssignment)) return false;
  for (const x of publishedAssignment) {
    if (x && x.trim()) return true;
  }
  return false;
}

function clearPublishedSeating(reason) {
  ensureParallelArrays();
  publishedAssignment = new Array(layout.exists.length).fill("");
  renderStudentView();
  saveSetup();
  if (reason) setStatus(reason);
}

// -------------------------
// Layout init
// -------------------------

function initLayout(rows, cols) {
  layout.rows = rows;
  layout.cols = cols;
  layout.exists = new Array(rows * cols).fill(false);
  ensureParallelArrays();
  // Clear seats/pins/assignment for new size
  publishedAssignment = new Array(layout.exists.length).fill("");
  fixedStudentBySeat = new Array(layout.exists.length).fill("");
  tableColorBySeat = new Array(layout.exists.length).fill("");
}

function resizeLayout(rows, cols) {
  // Like initLayout, but keeps seats, students, pins and colours that still fit.
  // Rows/cols are added or removed at the bottom/right.
  // Returns the number of seated students that fell outside the new grid.
  ensureParallelArrays();
  const old = {
    rows: layout.rows,
    cols: layout.cols,
    exists: layout.exists,
    published: publishedAssignment,
    fixed: fixedStudentBySeat,
    colors: tableColorBySeat
  };

  initLayout(rows, cols);

  let lost = 0;
  for (let r = 0; r < old.rows; r++) {
    for (let c = 0; c < old.cols; c++) {
      const oi = rcToIndex(r, c, old.cols);
      if (r >= rows || c >= cols) {
        if (old.exists[oi] && old.published[oi]) lost++;
        continue;
      }
      const ni = rcToIndex(r, c, cols);
      layout.exists[ni] = old.exists[oi];
      publishedAssignment[ni] = old.published[oi];
      fixedStudentBySeat[ni] = old.fixed[oi];
      tableColorBySeat[ni] = old.colors[oi];
    }
  }
  return lost;
}

// -------------------------
// Graph derivation
// -------------------------

function recomputeGraphs() {
  // Returns:
  // - pairAdjEdges: orthogonal seat-to-seat edges
  // - gapAdjEdges: seat-to-seat edges across an empty cell (including diagonals around that empty cell)
  const pairEdges = new Set();
  const gapEdges = new Set();

  const rows = layout.rows;
  const cols = layout.cols;

  function inBounds(r, c) {
    return r >= 0 && r < rows && c >= 0 && c < cols;
  }

  // Pair edges: orthogonal seat-to-seat
  for (let i = 0; i < layout.exists.length; i++) {
    if (!layout.exists[i]) continue;
    const { r, c } = indexToRC(i, cols);

    const dirs = [
      { r: r, c: c + 1 },
      { r: r, c: c - 1 },
      { r: r + 1, c: c },
      { r: r - 1, c: c }
    ];

    for (const d of dirs) {
      if (!inBounds(d.r, d.c)) continue;
      const j = rcToIndex(d.r, d.c, cols);
      if (layout.exists[j]) pairEdges.add(edgeKey(i, j));
    }
  }

  // Gap edges: share an adjacent empty cell (8-neighborhood around empty cell)
  for (let e = 0; e < layout.exists.length; e++) {
    if (layout.exists[e]) continue; // only empty cells
    const { r, c } = indexToRC(e, cols);

    const seatNeighbors = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (!inBounds(rr, cc)) continue;
        const idx = rcToIndex(rr, cc, cols);
        if (layout.exists[idx]) seatNeighbors.push(idx);
      }
    }

    for (let a = 0; a < seatNeighbors.length; a++) {
      for (let b = a + 1; b < seatNeighbors.length; b++) {
        gapEdges.add(edgeKey(seatNeighbors[a], seatNeighbors[b]));
      }
    }
  }

  return { pairEdges, gapEdges };
}

function buildAdjacencyFromEdges(edgeSet) {
  const map = new Map();
  for (const key of edgeSet) {
    const [aStr, bStr] = key.split("|");
    const a = Number(aStr);
    const b = Number(bStr);

    if (!map.has(a)) map.set(a, []);
    if (!map.has(b)) map.set(b, []);
    map.get(a).push(b);
    map.get(b).push(a);
  }
  return map;
}

function buildDirectAdjacency() {
  // Direct adjacency among seats (orthogonal neighbors). Used for MUST_DIRECT and loneliness scoring.
  const rows = layout.rows;
  const cols = layout.cols;

  function inBounds(r, c) {
    return r >= 0 && r < rows && c >= 0 && c < cols;
  }

  const adj = new Map();
  for (let i = 0; i < layout.exists.length; i++) {
    if (!layout.exists[i]) continue;

    const { r, c } = indexToRC(i, cols);
    const dirs = [
      { r: r, c: c + 1 },
      { r: r, c: c - 1 },
      { r: r + 1, c: c },
      { r: r - 1, c: c }
    ];

    const nbs = [];
    for (const d of dirs) {
      if (!inBounds(d.r, d.c)) continue;
      const j = rcToIndex(d.r, d.c, cols);
      if (layout.exists[j]) nbs.push(j);
    }
    adj.set(i, nbs);
  }
  return adj;
}

function computeSeatComponents(pairAdj) {
  // Connected components over orthogonal seat adjacency.
  const comp = new Array(layout.exists.length).fill(-1);
  let nextId = 0;

  for (let i = 0; i < layout.exists.length; i++) {
    if (!layout.exists[i]) continue;
    if (comp[i] !== -1) continue;

    const stack = [i];
    comp[i] = nextId;

    while (stack.length > 0) {
      const cur = stack.pop();
      const nbs = pairAdj.get(cur) || [];
      for (const nb of nbs) {
        if (comp[nb] === -1) {
          comp[nb] = nextId;
          stack.push(nb);
        }
      }
    }

    nextId++;
  }

  return comp;
}

function normalizeTableColors(componentId) {
  // Give every seat of a table the table's most common colour, so seats added to a
  // coloured table pick up its colour. Empty cells never keep a colour.
  ensureParallelArrays();
  const votes = new Map(); // cid -> Map(colorKey -> count)

  for (let i = 0; i < layout.exists.length; i++) {
    if (!layout.exists[i]) {
      tableColorBySeat[i] = "";
      continue;
    }
    const key = tableColorBySeat[i];
    if (!key || !TABLE_COLORS[key]) continue;
    const cid = componentId[i];
    if (!votes.has(cid)) votes.set(cid, new Map());
    const v = votes.get(cid);
    v.set(key, (v.get(key) || 0) + 1);
  }

  const colorOfComp = new Map();
  for (const [cid, v] of votes.entries()) {
    let best = "";
    let bestCount = 0;
    for (const [key, count] of v.entries()) {
      if (count > bestCount) {
        best = key;
        bestCount = count;
      }
    }
    colorOfComp.set(cid, best);
  }

  for (let i = 0; i < layout.exists.length; i++) {
    if (!layout.exists[i]) continue;
    tableColorBySeat[i] = colorOfComp.get(componentId[i]) || "";
  }
}

function applySeatColor(cell, key) {
  const color = TABLE_COLORS[key];
  cell.style.background = color ? color.fill : "";
  cell.style.borderColor = color ? color.stroke : "";
}

// -------------------------
// FIXED_SEAT logic (from restrictions)
// -------------------------

function fixedStudentsFromRestrictions() {
  const set = new Set();
  for (const r of restrictions) {
    if (r.type === "FIXED_SEAT" && r.a) set.add(r.a);
  }
  return set;
}

function cleanupFixedSeatsAgainstFixedStudents(fixedSet) {
  ensureParallelArrays();
  for (let i = 0; i < fixedStudentBySeat.length; i++) {
    const s = fixedStudentBySeat[i];
    if (!s) continue;
    if (!fixedSet.has(s)) fixedStudentBySeat[i] = "";
    if (s && !studentNames.includes(s)) fixedStudentBySeat[i] = "";
    if (!layout.exists[i]) fixedStudentBySeat[i] = "";
  }
}

function ensureFixedStudentsVisibleInTeacherDraft(draft) {
  // Teacher-only pre-placement:
  // - Show FIXED_SEAT students somewhere in the grid if seats exist.
  // - If they already have a fixed seat, keep them there.
  // - If they do not, assign them the first available seat and fix it.
  const fixedSet = fixedStudentsFromRestrictions();
  cleanupFixedSeatsAgainstFixedStudents(fixedSet);

  // Which fixed students already have a seat?
  const alreadyPinned = new Set();
  for (const s of fixedStudentBySeat) if (s) alreadyPinned.add(s);

  // Build seat list
  const seatIdxs = [];
  for (let i = 0; i < layout.exists.length; i++) {
    if (layout.exists[i]) seatIdxs.push(i);
  }

  // Place missing fixed students
  for (const fixedStudent of fixedSet) {
    if (alreadyPinned.has(fixedStudent)) continue;
    if (!studentNames.includes(fixedStudent)) continue;

    // Find first seat that is not pinned to someone else
    let chosen = -1;
    for (const idx of seatIdxs) {
      if (fixedStudentBySeat[idx]) continue; // already pinned seat
      chosen = idx;
      break;
    }

    if (chosen !== -1) {
      fixedStudentBySeat[chosen] = fixedStudent;
      alreadyPinned.add(fixedStudent);
    }
  }

  // Overlay fixed students into the teacher draft view (not absent ones: their seat is
  // free while they're away)
  for (let i = 0; i < fixedStudentBySeat.length; i++) {
    const s = fixedStudentBySeat[i];
    if (!s || absentStudents.has(s)) continue;
    if (!layout.exists[i]) continue;
    draft[i] = s;
  }
}

// -------------------------
// Rendering
// -------------------------

function chartTitle() {
  return chartNameInput.value.trim() || "Seating chart";
}

function renderStudentView() {
  ensureParallelArrays();
  chartTitleEl.textContent = chartTitle();

  // Equal square cells sized for the longest name, capped in CSS (longer names wrap).
  // The grid is fit-content wide, so 1fr columns all take the largest seat's width.
  seatingGrid.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(90px, 1fr))`;
  seatingGrid.innerHTML = "";
  seatingGrid.classList.toggle("flipped", !!studentViewFlipped);

  for (let i = 0; i < layout.exists.length; i++) {
    const cell = document.createElement("div");
    cell.className = "seat" + (layout.exists[i] ? "" : " empty");
    cell.textContent = layout.exists[i] ? (publishedAssignment[i] || "") : "";
    // Smaller text for long names/words, so they wrap between words rather than inside one
    const nameHere = cell.textContent;
    const longestWord = Math.max(0, ...nameHere.split(/[\s-]+/).map(w => w.length));
    if (longestWord > 12 || nameHere.length > 30) cell.classList.add("name-xs");
    else if (longestWord > 8 || nameHere.length > 20) cell.classList.add("name-s");
    if (layout.exists[i] && showColorsInput.checked) applySeatColor(cell, tableColorBySeat[i]);
    seatingGrid.appendChild(cell);
  }
}

function renderSeatEditor() {
  ensureParallelArrays();

  // Teacher-only grouping visuals: highlight adjacent "tables" (connected seat groups)
  const { pairEdges } = recomputeGraphs();
  const pairAdj = buildAdjacencyFromEdges(pairEdges);
  const compId = computeSeatComponents(pairAdj);
  normalizeTableColors(compId);

  // Teacher draft: start from published seating, but overlay fixed students (teacher-only visibility)
  const draft = publishedAssignment.slice();
  ensureFixedStudentsVisibleInTeacherDraft(draft);

  seatEditor.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(60px, 1fr))`;
  seatEditor.innerHTML = "";

  // Drag helpers
  function onDragStartSeat(e, seatIdx) {
    e.dataTransfer.setData("text/plain", String(seatIdx));
  }

  function onDropSeat(e, toIdx) {
    e.preventDefault();
    const fromStr = e.dataTransfer.getData("text/plain");
    const fromIdx = Number(fromStr);
    if (!Number.isFinite(fromIdx)) return;
    trySwapOrMoveInTeacherDraft(fromIdx, toIdx);
  }

  for (let i = 0; i < layout.exists.length; i++) {
    const cell = document.createElement("div");
    cell.dataset.index = String(i);

    // Gap cell: clicking/dragging adds seats (handled by startPaint)
    if (!layout.exists[i]) {
      cell.className = "seat empty";
      cell.textContent = "";
      seatEditor.appendChild(cell);
      continue;
    }

    // Seat cell: show draft name or "Seat"
    cell.className = "seat";
    applySeatColor(cell, tableColorBySeat[i]);

    // Mark group membership for teacher view (visualized by SVG overlay)
    const cid = compId[i];
    if (cid !== -1) {
      cell.classList.add("group");
      const nbs = pairAdj.get(i) || [];
      if (nbs.length === 0) cell.classList.add("isolated");
    }

    const pinned = (fixedStudentBySeat[i] && !absentStudents.has(fixedStudentBySeat[i])) ? fixedStudentBySeat[i] : "";
    const nameHere = draft[i] || "";

    // Long names are cut off with an ellipsis (CSS); hover shows the full name.
    const label = document.createElement("span");
    label.className = "seat-name";
    label.textContent = nameHere ? nameHere : "Seat";
    cell.appendChild(label);
    if (nameHere) cell.title = nameHere;
    if (pinned) {
      const pin = document.createElement("span");
      pin.className = "seat-pin";
      pin.textContent = "📌";
      cell.appendChild(pin);
    }

    // Drag if there is a student shown here (not while colouring, so tables can be
    // coloured by dragging across them)
    cell.draggable = !!nameHere && activeTool === "seats";
    if (cell.draggable) {
      cell.addEventListener("dragstart", (e) => onDragStartSeat(e, i));
    }
    // allow drop into any seat
    cell.addEventListener("dragover", (e) => e.preventDefault());
    cell.addEventListener("drop", (e) => onDropSeat(e, i));

    // Click a seat with a student => remove seat. (Seats without a student are
    // removed via click/drag in startPaint; seats with one start a student drag.)
    if (cell.draggable) {
      cell.addEventListener("click", () => {
        // Removing a seat clears any published assignment and any pin at that seat.
        removeSeat(i);
        updateCounts();
        renderSeatEditor();
        renderStudentView();
        saveSetup();
        setStatus("Seat removed.");
      });
    }

    seatEditor.appendChild(cell);
  }

  fitTeacherSeatNames();

  // Draw SVG cluster outlines last (so it can bridge grid gaps)
  drawTeacherClusterOutlines(seatEditor, pairAdj, compId);
}

// -------------------------
// Click-and-drag painting (teacher seat editor)
// -------------------------
// Seats tool: starting on an empty cell adds seats under the pointer, starting on a seat
// removes them. Colour tools: every table the pointer touches gets the colour.
// The DOM is patched while dragging; the full re-render happens in finishPaint.

function removeSeat(i) {
  ensureParallelArrays();
  layout.exists[i] = false;
  publishedAssignment[i] = "";
  fixedStudentBySeat[i] = "";
  tableColorBySeat[i] = "";
}

function seatCellFromEvent(e) {
  const cell = e.target.closest ? e.target.closest("[data-index]") : null;
  return cell && seatEditor.contains(cell) ? cell : null;
}

function paintCell(cell) {
  const i = Number(cell.dataset.index);
  if (!Number.isInteger(i)) return;

  if (paint.kind === "seats") {
    if (layout.exists[i] === paint.add) return;
    if (paint.add) {
      layout.exists[i] = true;
      cell.className = "seat";
      cell.textContent = "Seat";
    } else {
      removeSeat(i);
      cell.className = "seat empty";
      cell.textContent = "";
      cell.draggable = false;
      applySeatColor(cell, "");
    }
    paint.changed = true;
    return;
  }

  // Colour tools
  if (!layout.exists[i]) return;
  const cid = paint.componentId[i];
  if (paint.coloured.has(cid)) return;
  paint.coloured.add(cid);

  const key = paint.kind === "none" ? "" : paint.kind;
  for (let j = 0; j < layout.exists.length; j++) {
    if (paint.componentId[j] !== cid) continue;
    tableColorBySeat[j] = key;
    const el = seatEditor.querySelector(`[data-index="${j}"]`);
    if (el) applySeatColor(el, key);
  }
  paint.changed = true;
}

function startPaint(e) {
  if (e.button !== 0) return;
  const cell = seatCellFromEvent(e);
  if (!cell) return;
  if (cell.draggable) return; // seat with a student: let drag & drop move them

  e.preventDefault();
  ensureParallelArrays();

  if (activeTool === "seats") {
    paint = { kind: "seats", add: !layout.exists[Number(cell.dataset.index)], changed: false };
  } else {
    const pairAdj = buildAdjacencyFromEdges(recomputeGraphs().pairEdges);
    paint = { kind: activeTool, componentId: computeSeatComponents(pairAdj), coloured: new Set(), changed: false };
  }
  paintCell(cell);
}

function continuePaint(e) {
  if (!paint) return;
  const cell = seatCellFromEvent(e);
  if (cell) paintCell(cell);
}

function finishPaint() {
  if (!paint) return;
  const done = paint;
  paint = null;
  if (!done.changed) return;

  updateCounts();
  renderSeatEditor();
  renderStudentView();
  saveSetup();

  if (done.kind === "seats") setStatus(done.add ? "Seats added." : "Seats removed.");
  else if (done.kind === "none") setStatus("Table colour removed.");
  else setStatus(`Tables coloured ${TABLE_COLORS[done.kind].label.toLowerCase()}.`);
}

function renderToolBar() {
  // Two groups: "Edit seats", and round colour swatches (deliberately not seat-shaped,
  // so they aren't mistaken for seats). The hint below says what a click/drag does now.
  toolBar.innerHTML = "";

  function addGroup(labelText) {
    const group = document.createElement("div");
    group.className = "tool-group";
    const label = document.createElement("span");
    label.className = "tool-group-label";
    label.textContent = labelText;
    group.appendChild(label);
    toolBar.appendChild(group);
    return group;
  }

  function addToolButton(group, tool, className, text, title) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className + (activeTool === tool ? " active" : "");
    btn.textContent = text;
    btn.title = title;
    btn.setAttribute("aria-pressed", String(activeTool === tool));
    btn.addEventListener("click", () => {
      activeTool = tool;
      renderToolBar();
      renderSeatEditor();
    });
    group.appendChild(btn);
    return btn;
  }

  const editGroup = addGroup("Edit:");
  addToolButton(editGroup, "seats", "tool", "Add / remove seats", "Add or remove seats");

  const colourGroup = addGroup("Colour tables:");
  for (const [key, color] of Object.entries(TABLE_COLORS)) {
    const btn = addToolButton(colourGroup, key, "swatch", "", `Colour tables ${color.label.toLowerCase()}`);
    btn.style.background = color.fill;
    btn.style.borderColor = color.stroke;
    btn.setAttribute("aria-label", btn.title);
  }
  addToolButton(colourGroup, "none", "swatch swatch-none", "✕", "Remove table colour");

  // Hint for the active tool
  toolHint.innerHTML = "";
  const strong = document.createElement("b");
  let text;
  const color = TABLE_COLORS[activeTool];
  if (activeTool === "seats") {
    strong.textContent = "Editing seats: ";
    text = "click or drag across empty cells to add seats; start on a seat to remove seats instead. " +
      "Drag a student to move them.";
  } else {
    strong.textContent = color ? `Colouring tables ${color.label.toLowerCase()}: ` : "Removing table colours: ";
    text = "click a table to " + (color ? "colour" : "clear") + " the whole table, or drag across several tables. " +
      "Colouring doesn't add seats — choose \"Add / remove seats\" for that.";
  }
  toolHint.appendChild(strong);
  toolHint.appendChild(document.createTextNode(text));
  toolHint.style.borderLeftColor = color ? color.stroke : "";

  seatEditor.classList.toggle("coloring", activeTool !== "seats");
}

function fitTeacherSeatNames() {
  // Shrink a name (down to 10px) while a word is wider than its seat or it needs more
  // than the two lines CSS allows. Needs the teacher view visible to measure; when
  // hidden nothing overflows (all sizes are 0) and switchToTeacherView re-renders.
  for (const el of seatEditor.querySelectorAll(".seat-name")) {
    let size = parseFloat(getComputedStyle(el).fontSize) || 14;
    while (size > 10 && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
      size--;
      el.style.fontSize = `${size}px`;
    }
  }
}

function trySwapOrMoveInTeacherDraft(fromIdx, toIdx) {
  ensureParallelArrays();

  if (!layout.exists[fromIdx] || !layout.exists[toIdx]) return;
  if (fromIdx === toIdx) return;

  // Build current teacher draft
  const draft = publishedAssignment.slice();
  ensureFixedStudentsVisibleInTeacherDraft(draft);

  const fromName = draft[fromIdx] || "";
  const toName = draft[toIdx] || "";

  if (!fromName) return; // nothing to move

  const fixedSet = fixedStudentsFromRestrictions();

  const fromIsFixedStudent = fixedSet.has(fromName);
  const toIsFixedStudent = toName ? fixedSet.has(toName) : false;

  // If target seat is pinned to some other (present) fixed student, block
  const pins = activePins();
  const pinnedTo = pins[toIdx];
  if (pinnedTo && pinnedTo !== fromName) {
    alert("That seat is fixed for a different student.");
    return;
  }

  // If moving a fixed student: update its fixed seat
  if (fromIsFixedStudent) {
    // Clear old pin
    for (let i = 0; i < fixedStudentBySeat.length; i++) {
      if (fixedStudentBySeat[i] === fromName) fixedStudentBySeat[i] = "";
    }
    fixedStudentBySeat[toIdx] = fromName;

    // If we're swapping with another fixed student, also update theirs
    if (toName && toIsFixedStudent) {
      for (let i = 0; i < fixedStudentBySeat.length; i++) {
        if (fixedStudentBySeat[i] === toName) fixedStudentBySeat[i] = "";
      }
      fixedStudentBySeat[fromIdx] = toName;
    } else if (toName && !toIsFixedStudent) {
      // The other student is not fixed: they can move, but only affects published seating if it exists
      // We'll treat drag as editing the seating only if there is already a published seating.
    }
  } else {
    // Non-fixed student: cannot move into a seat pinned to someone else
    const pinned = pins[toIdx];
    if (pinned && pinned !== fromName) {
      alert("That seat is fixed for a different student.");
      return;
    }
  }

  // Apply the swap/move:
  // If we already have a published seating, treat drag as editing it (so student view updates).
  // If published is empty (fresh after changes), keep it teacher-only: only pins update.
  const publishEdits = anyPublishedSeating();

  if (publishEdits) {
    // Swap in published assignment (only among existing seat cells)
    const a = publishedAssignment[fromIdx] || "";
    const b = publishedAssignment[toIdx] || "";

    // If a isn't in published (because it was only teacher preview fixed), force it in
    // (this can happen if you drag fixed students before ever generating)
    if (!a) {
      // make sure we don't duplicate names
      removeStudentFromPublished(fromName);
      publishedAssignment[fromIdx] = fromName;
    }

    // Now swap
    const a2 = publishedAssignment[fromIdx] || "";
    const b2 = publishedAssignment[toIdx] || "";
    publishedAssignment[fromIdx] = b2;
    publishedAssignment[toIdx] = a2;

    // Enforce pinned seats in published
    enforcePinsOnPublished();
  }

  renderSeatEditor();
  renderStudentView();
  saveSetup();
}

function removeStudentFromPublished(name) {
  if (!name) return;
  for (let i = 0; i < publishedAssignment.length; i++) {
    if (publishedAssignment[i] === name) publishedAssignment[i] = "";
  }
}

function enforcePinsOnPublished() {
  const fixedSet = fixedStudentsFromRestrictions();
  cleanupFixedSeatsAgainstFixedStudents(fixedSet);

  // Remove fixed students from everywhere first, then place them at their fixed seat.
  // Absent fixed students stay off the chart. Placing a pin can overwrite whoever sat
  // there; syncPublishedWithPresent reseats them.
  for (const s of fixedSet) removeStudentFromPublished(s);

  for (let i = 0; i < fixedStudentBySeat.length; i++) {
    const s = fixedStudentBySeat[i];
    if (!s || absentStudents.has(s)) continue;
    if (!layout.exists[i]) continue;
    if (!fixedSet.has(s)) continue;
    publishedAssignment[i] = s;
  }
}

// -------------------------
// Restrictions UI
// -------------------------

function makeSelect(options, value) {
  const sel = document.createElement("select");
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    sel.appendChild(o);
  }
  if (value !== undefined) sel.value = value;
  return sel;
}

function refreshNamesFromTextarea() {
  // Applies the textarea (called on its change event, i.e. when it loses focus).
  const oldNames = studentNames;
  const oldPresent = presentStudents();
  const newNames = parseNames(namesInput.value);
  if (newNames.length === oldNames.length && newNames.every((n, k) => n === oldNames[k])) {
    updateCounts();
    return;
  }
  studentNames = newNames;
  for (const n of Array.from(absentStudents)) {
    if (!studentNames.includes(n)) absentStudents.delete(n);
  }

  // Remove restrictions referencing missing students (except FIXED_SEAT uses only A)
  const old = restrictions.map(r => ({ a: r.a, b: r.b, type: r.type }));
  restrictionsList.innerHTML = "";
  restrictions = [];

  for (const r of old) {
    if (!r.a || !studentNames.includes(r.a)) continue;

    if (r.type === "FIXED_SEAT") {
      addRestrictionRow({ a: r.a, b: "", type: "FIXED_SEAT" });
      continue;
    }

    if (!r.b || !studentNames.includes(r.b)) continue;
    addRestrictionRow({ a: r.a, b: r.b, type: r.type });
  }

  // Remove pins to removed students
  ensureParallelArrays();
  const fixedSet = fixedStudentsFromRestrictions();
  cleanupFixedSeatsAgainstFixedStudents(fixedSet);

  groupRules = groupRules.filter(r => studentNames.includes(r.a) && studentNames.includes(r.b));
  renderGroupRules();

  let msg = "Names updated.";
  if (anyPublishedSeating()) msg += " " + syncPublishedWithPresent(oldPresent);
  const groupsMsg = syncGroupsWithPresent(oldPresent);
  if (groupsMsg) msg += " " + groupsMsg;
  renderGroups();

  updateCounts();
  renderSeatEditor();
  renderStudentView();
  saveSetup();
  setStatus(msg);
}

function activePins() {
  // fixedStudentBySeat without absent students: their pinned seat is free while they're away
  ensureParallelArrays();
  return fixedStudentBySeat.map(s => (s && !absentStudents.has(s)) ? s : "");
}

function syncPublishedWithPresent(oldPresent) {
  // Keep the published seating in line with who is present, without reshuffling:
  // students no longer present (removed or absent) leave their seat, everyone else stays
  // put. Unseated present students first take a seat vacated in this update (so a
  // renamed student keeps their seat), then the best free seat that avoids leaving
  // someone alone at a table. Returns a status message.
  const present = presentStudents();
  const pins = activePins();

  const vacated = [];
  for (const name of oldPresent) {
    if (present.includes(name)) continue;
    const idx = publishedAssignment.indexOf(name);
    if (idx !== -1) {
      publishedAssignment[idx] = "";
      vacated.push(idx);
    }
  }
  // Drop anyone else who shouldn't be seated (e.g. stale data)
  for (let i = 0; i < publishedAssignment.length; i++) {
    if (publishedAssignment[i] && !present.includes(publishedAssignment[i])) publishedAssignment[i] = "";
  }

  // Pins first: a returning pinned student takes back their seat, and whoever sat there
  // becomes unseated and is placed below.
  enforcePinsOnPublished();

  const unseated = present.filter(n => !publishedAssignment.includes(n));
  if (unseated.length === 0) {
    return vacated.length ? "Their seat is now free; the rest of the seating is unchanged." : "";
  }

  const pairAdj = buildAdjacencyFromEdges(recomputeGraphs().pairEdges);
  const componentId = computeSeatComponents(pairAdj);

  function isFree(idx) {
    return layout.exists[idx] && !publishedAssignment[idx] && !pins[idx];
  }

  const seatsInComp = new Map();
  const usedInComp = new Map();
  for (let i = 0; i < layout.exists.length; i++) {
    if (!layout.exists[i]) continue;
    const cid = componentId[i];
    seatsInComp.set(cid, (seatsInComp.get(cid) || 0) + 1);
    if (publishedAssignment[i] || pins[i]) usedInComp.set(cid, (usedInComp.get(cid) || 0) + 1);
  }

  function freeSeatScore(idx) {
    // Best: join someone sitting alone. Then: join an occupied table. Then: a single-seat
    // table. Worst: open an empty table (the new student would sit alone).
    const cid = componentId[idx];
    const used = usedInComp.get(cid) || 0;
    const total = seatsInComp.get(cid) || 0;
    let bonus = 0;
    if (total < 2) bonus = 5000;
    else if (used === 1) bonus = 20000;
    else if (used >= 2) bonus = 10000;
    return bonus + seatPreferenceScore(idx);
  }

  const placed = [];
  const notPlaced = [];
  for (const name of unseated) {
    let seat = -1;
    while (vacated.length > 0 && seat === -1) {
      const idx = vacated.shift();
      if (isFree(idx)) seat = idx;
    }
    if (seat === -1) {
      let best = -Infinity;
      for (let i = 0; i < layout.exists.length; i++) {
        if (!isFree(i)) continue;
        const score = freeSeatScore(i);
        if (score > best) {
          best = score;
          seat = i;
        }
      }
    }

    if (seat === -1) {
      notPlaced.push(name);
      continue;
    }
    publishedAssignment[seat] = name;
    const cid = componentId[seat];
    usedInComp.set(cid, (usedInComp.get(cid) || 0) + 1);
    placed.push(name);
  }

  enforcePinsOnPublished();

  const parts = [];
  if (placed.length) parts.push(`Seated ${placed.join(", ")} without changing the rest.`);
  if (notPlaced.length) parts.push(`No free seat for ${notPlaced.join(", ")}: add seats or regenerate.`);
  return parts.join(" ");
}

function addRestrictionRow(initial) {
  if (studentNames.length < 1) {
    alert("Add names first.");
    return;
  }

  const row = document.createElement("div");
  row.className = "restriction-row";

  // Name options
  const nameOptions = studentNames.map(n => ({ value: n, label: n }));
  const blankOption = [{ value: "", label: "(none)" }];

  const typeOptions = [
    { value: "PAIR", label: "Not at same table" },
    { value: "GAP", label: "Not at adjacent tables" },
    { value: "MUST_DIRECT", label: "Must be directly adjacent" },
    { value: "FIXED_SEAT", label: "Specific seat" }
  ];

  const aSel = makeSelect(nameOptions, initial?.a ?? studentNames[0]);
  const bSel = makeSelect(blankOption.concat(nameOptions), initial?.b ?? "");
  const tSel = makeSelect(typeOptions, initial?.type ?? "PAIR");

  const removeBtn = document.createElement("button");
  removeBtn.className = "secondary";
  removeBtn.textContent = "Remove";

  row.appendChild(aSel);
  row.appendChild(bSel);
  row.appendChild(tSel);
  row.appendChild(removeBtn);
  restrictionsList.appendChild(row);

  const restrictionObj = {
    a: aSel.value,
    b: bSel.value,
    type: tSel.value
  };
  restrictions.push(restrictionObj);

  function applyTypeUI() {
    if (tSel.value === "FIXED_SEAT") {
      bSel.value = "";
      bSel.disabled = true;
      bSel.style.opacity = "0.6";
      restrictionObj.b = "";
    } else {
      bSel.disabled = false;
      bSel.style.opacity = "1";
      if (!bSel.value) {
        // pick a different default if possible
        const fallback = studentNames.find(n => n !== aSel.value) || studentNames[0] || "";
        bSel.value = fallback;
      }
      restrictionObj.b = bSel.value;
    }
  }

  function syncAndClearPublished(reason) {
    restrictionObj.a = aSel.value;
    restrictionObj.b = bSel.value;
    restrictionObj.type = tSel.value;

    applyTypeUI();

    // Any restriction change => clear published seating
    clearPublishedSeating(reason || "Restrictions changed — cleared seating chart.");

    // Also cleanup fixed seats if FIXED_SEAT set changed
    const fixedSet = fixedStudentsFromRestrictions();
    cleanupFixedSeatsAgainstFixedStudents(fixedSet);

    renderSeatEditor();
    renderStudentView();
    updateCounts();
    saveSetup();
  }

  aSel.addEventListener("change", () => syncAndClearPublished("Restrictions changed — cleared seating chart."));
  bSel.addEventListener("change", () => syncAndClearPublished("Restrictions changed — cleared seating chart."));
  tSel.addEventListener("change", () => syncAndClearPublished("Restrictions changed — cleared seating chart."));

  removeBtn.addEventListener("click", () => {
    restrictionsList.removeChild(row);
    restrictions = restrictions.filter(x => x !== restrictionObj);

    clearPublishedSeating("Restrictions changed — cleared seating chart.");

    const fixedSet = fixedStudentsFromRestrictions();
    cleanupFixedSeatsAgainstFixedStudents(fixedSet);

    renderSeatEditor();
    renderStudentView();
    updateCounts();
    saveSetup();
  });

  applyTypeUI();
  saveSetup();
}

// -------------------------
// Persistence
// -------------------------
// store = { version: 2, currentId, teacherPin, classes: [{ id, data }], rooms: [room] }
// room  = { id, name, rows, cols, layoutExists, tableColorBySeat }  (shared by all classes)
// data  = one class: names, restrictions, groups, ..., roomId (the classroom it's showing)
//         and charts: { [roomId]: { seats, pins } }, a seating chart per classroom. seats
//         and pins map "row,col" -> name, so resizing a room doesn't scramble other
//         classes' charts (cells that no longer exist are dropped when loaded).

// True while applyClassData runs: it restores state step by step, so saving midway
// (e.g. from addRestrictionRow) would store a half-loaded class.
let applyingClass = false;

// The classroom being shown (the current class's roomId)
let activeRoomId = "";

function cellMapFromArray(arr, cols) {
  const map = {};
  arr.forEach((name, i) => {
    if (name) map[`${Math.floor(i / cols)},${i % cols}`] = name;
  });
  return map;
}

function arrayFromCellMap(map, rows, cols) {
  const arr = new Array(rows * cols).fill("");
  if (!map || typeof map !== "object") return arr;
  for (const [key, name] of Object.entries(map)) {
    const [r, c] = key.split(",").map(Number);
    if (typeof name === "string" && r >= 0 && r < rows && c >= 0 && c < cols) arr[r * cols + c] = name;
  }
  return arr;
}

function buildClassData() {
  // Everything that belongs to the current class (the PIN and classrooms are shared)
  ensureParallelArrays();
  const prev = currentClass().data || {};
  const charts = Object.assign({}, prev.charts); // other classrooms' charts as they were
  charts[activeRoomId] = {
    seats: cellMapFromArray(publishedAssignment, layout.cols),
    pins: cellMapFromArray(fixedStudentBySeat, layout.cols)
  };
  return {
    namesText: namesInput.value,
    absent: Array.from(absentStudents),
    restrictions: restrictions.map(r => ({ a: r.a, b: r.b, type: r.type })),
    chartName: chartNameInput.value || "",
    showColors: showColorsInput.checked,
    groupSettings: Object.assign({}, groupSettings),
    groupRules: groupRules.map(r => ({ a: r.a, b: r.b, type: r.type })),
    groups: groups.map(g => g.slice()),
    roomId: activeRoomId,
    charts
  };
}

function saveRoomFromState() {
  // The actual grid size, not the inputs: they may hold an unapplied resize
  const room = currentRoom();
  if (!room) return;
  room.name = roomNameInput.value || "";
  room.rows = layout.rows;
  room.cols = layout.cols;
  room.layoutExists = layout.exists.slice();
  room.tableColorBySeat = tableColorBySeat.slice();
}

function saveSetup() {
  if (!store || applyingClass) return; // still starting up / loading a class
  saveRoomFromState();
  currentClass().data = buildClassData();
  store.teacherPin = pinInput.value || "";
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (e) {
    console.error(e);
    setStatus("Couldn't save in this browser. Export a backup so nothing is lost.");
  }
}

function newClassId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function currentClass() {
  return store.classes.find(c => c.id === store.currentId) || store.classes[0];
}

function currentRoom() {
  return store.rooms.find(r => r.id === activeRoomId) || store.rooms[0];
}

function className(data) {
  return (data && typeof data.chartName === "string" && data.chartName.trim()) || "Untitled class";
}

function roomName(room) {
  return (room && typeof room.name === "string" && room.name.trim()) || "Untitled classroom";
}

function uniqueName(base, taken, label) {
  // base, or with a number added: "X (label)", "X (label 2)"... or "X 2", "X 3"...
  if (!taken.has(base)) return base;
  for (let n = 1; ; n++) {
    const name = label ? (n === 1 ? `${base} (${label})` : `${base} (${label} ${n})`) : `${base} ${n + 1}`;
    if (!taken.has(name)) return name;
  }
}

function makeRoom(name, rows = 7, cols = 10) {
  return {
    id: newClassId(),
    name,
    rows,
    cols,
    layoutExists: new Array(rows * cols).fill(false),
    tableColorBySeat: new Array(rows * cols).fill("")
  };
}

function cleanRoom(r) {
  // A valid room from saved/imported data
  r = (r && typeof r === "object") ? r : {};
  const rows = Math.max(1, Math.min(30, Number(r.rows) || 7));
  const cols = Math.max(1, Math.min(30, Number(r.cols) || 10));
  const room = makeRoom(typeof r.name === "string" ? r.name : "", rows, cols);
  if (typeof r.id === "string" && r.id) room.id = r.id;
  const n = rows * cols;
  if (Array.isArray(r.layoutExists) && r.layoutExists.length === n) room.layoutExists = r.layoutExists.map(Boolean);
  if (Array.isArray(r.tableColorBySeat) && r.tableColorBySeat.length === n) {
    room.tableColorBySeat = r.tableColorBySeat.map(x => TABLE_COLORS[x] ? x : "");
  }
  return room;
}

function sameLayout(a, b) {
  return a.rows === b.rows && a.cols === b.cols &&
    JSON.stringify(a.layoutExists) === JSON.stringify(b.layoutExists) &&
    JSON.stringify(a.tableColorBySeat) === JSON.stringify(b.tableColorBySeat);
}

function convertOldClassData(data, nameHint) {
  // Classes saved before classrooms existed carry their own layout and chart arrays.
  // Move the layout into a classroom (reusing one with an identical layout) and the
  // chart into data.charts. Data that already has charts is returned unchanged.
  data = (data && typeof data === "object") ? Object.assign({}, data) : {};
  if (data.charts && typeof data.charts === "object") return data;

  const layoutRoom = cleanRoom({
    rows: data.rows, cols: data.cols, layoutExists: data.layoutExists, tableColorBySeat: data.tableColorBySeat
  });
  let room = store.rooms.find(r => sameLayout(r, layoutRoom));
  if (!room) {
    room = layoutRoom;
    room.id = newClassId();
    room.name = uniqueName(`Classroom (${nameHint})`, new Set(store.rooms.map(roomName)), "");
    store.rooms.push(room);
  }

  const n = room.rows * room.cols;
  const arr = (a) => (Array.isArray(a) && a.length === n) ? a.map(x => typeof x === "string" ? x : "") : [];
  const chart = {
    seats: cellMapFromArray(arr(data.publishedAssignment), room.cols),
    pins: cellMapFromArray(arr(data.fixedStudentBySeat), room.cols)
  };
  for (const k of ["rows", "cols", "layoutExists", "tableColorBySeat", "publishedAssignment", "fixedStudentBySeat"]) delete data[k];
  data.roomId = room.id;
  data.charts = { [room.id]: chart };
  return data;
}

function loadStore() {
  // Sets `store`. Migrates the old single-class save (STORAGE_KEY) and classes from
  // before classrooms existed.
  let parsed = null;
  try {
    parsed = JSON.parse(localStorage.getItem(STORE_KEY));
  } catch (e) {
    console.error(e);
  }

  if (parsed && Array.isArray(parsed.classes) && parsed.classes.length > 0) {
    store = parsed;
  } else {
    let old = null;
    try {
      old = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (e) {
      console.error(e);
    }
    const data = (old && typeof old === "object") ? old : {};
    const teacherPin = typeof data.teacherPin === "string" ? data.teacherPin : "";
    delete data.teacherPin;
    const id = newClassId();
    store = { currentId: id, teacherPin, classes: [{ id, data }] };
  }

  store.version = 2;
  store.rooms = (Array.isArray(store.rooms) ? store.rooms : []).map(cleanRoom);
  for (const cls of store.classes) cls.data = convertOldClassData(cls.data, className(cls.data));
  if (store.rooms.length === 0) store.rooms.push(makeRoom("Classroom"));
  for (const cls of store.classes) {
    if (!store.rooms.some(r => r.id === cls.data.roomId)) cls.data.roomId = store.rooms[0].id;
  }
  if (!store.classes.some(c => c.id === store.currentId)) store.currentId = store.classes[0].id;
}

function applyClassData(data) {
  // Load one class (in its current classroom) into the UI and state. Tolerates missing
  // or bad fields (new classes and imported backups), falling back to defaults.
  // Returns a note for the status line ("" if nothing to report).
  data = (data && typeof data === "object") ? data : {};
  applyingClass = true;
  try {
    activeRoomId = store.rooms.some(r => r.id === data.roomId) ? data.roomId : store.rooms[0].id;
    const room = currentRoom();
    roomNameInput.value = room.name || "";

    namesInput.value = typeof data.namesText === "string" ? data.namesText : "";
    studentNames = parseNames(namesInput.value);
    absentStudents = new Set((Array.isArray(data.absent) ? data.absent : []).filter(n => studentNames.includes(n)));

    rowsInput.value = room.rows;
    colsInput.value = room.cols;
    initLayout(room.rows, room.cols);
    layout.exists = room.layoutExists.slice();
    tableColorBySeat = room.tableColorBySeat.slice();

    const chart = (data.charts && data.charts[room.id]) || {};
    publishedAssignment = arrayFromCellMap(chart.seats, room.rows, room.cols);
    fixedStudentBySeat = arrayFromCellMap(chart.pins, room.rows, room.cols);
    // Seats removed while another class was showing lose their student and pin
    for (let i = 0; i < layout.exists.length; i++) {
      if (!layout.exists[i]) {
        publishedAssignment[i] = "";
        fixedStudentBySeat[i] = "";
      }
    }

    chartNameInput.value = typeof data.chartName === "string" ? data.chartName : "";
    showColorsInput.checked = data.showColors !== false;

    // Restore restrictions
    restrictionsList.innerHTML = "";
    restrictions = [];
    if (Array.isArray(data.restrictions)) {
      for (const r0 of data.restrictions) {
        if (!r0 || !r0.a || !studentNames.includes(r0.a)) continue;

        if (r0.type === "FIXED_SEAT") {
          addRestrictionRow({ a: r0.a, b: "", type: "FIXED_SEAT" });
          continue;
        }

        if (!r0.b || !studentNames.includes(r0.b)) continue;
        addRestrictionRow({ a: r0.a, b: r0.b, type: ["PAIR", "GAP", "MUST_DIRECT"].includes(r0.type) ? r0.type : "PAIR" });
      }
    }

    // Cleanup pins/assignments vs current names and fixed set
    ensureParallelArrays();
    const fixedSet = fixedStudentsFromRestrictions();
    cleanupFixedSeatsAgainstFixedStudents(fixedSet);

    // Remove anyone from the published seating who isn't a present student
    const present = presentStudents();
    for (let i = 0; i < publishedAssignment.length; i++) {
      if (publishedAssignment[i] && !present.includes(publishedAssignment[i])) {
        publishedAssignment[i] = "";
      }
    }

    // Present students without a seat (e.g. their seat was removed while another class
    // was showing, or they were added in another classroom) get a free seat
    let note = "";
    const pins = activePins();
    if (anyPublishedSeating() && present.some(n => !publishedAssignment.includes(n) && !pins.includes(n))) {
      note = syncPublishedWithPresent(present);
    }

    // Groups
    stopGroupAnimation();
    const gs = (data.groupSettings && typeof data.groupSettings === "object") ? data.groupSettings : {};
    groupSettings = {
      mode: gs.mode === "count" ? "count" : "size",
      value: Math.max(1, Math.min(99, Math.floor(Number(gs.value) || 4))),
      useSeatingRules: gs.useSeatingRules !== false
    };
    groupModeSelect.value = groupSettings.mode;
    groupValueInput.value = groupSettings.value;
    groupUseSeatingInput.checked = groupSettings.useSeatingRules;
    groupRules = (Array.isArray(data.groupRules) ? data.groupRules : [])
      .filter(r => r && studentNames.includes(r.a) && studentNames.includes(r.b))
      .map(r => ({ a: r.a, b: r.b, type: r.type === "TOGETHER" ? "TOGETHER" : "APART" }));
    groups = (Array.isArray(data.groups) ? data.groups : [])
      .filter(Array.isArray)
      .map(g => g.filter(n => present.includes(n)))
      .filter(g => g.length > 0);
    renderGroupRules();
    renderGroups();

    updateCounts();
    renderNameMessages();
    renderSeatEditor();
    renderStudentView();
    return note;
  } finally {
    applyingClass = false;
  }
}

// -------------------------
// Classes, classrooms, backup export/import
// -------------------------

function renderClassSelect() {
  classSelect.innerHTML = "";
  for (const cls of store.classes) {
    const opt = document.createElement("option");
    opt.value = cls.id;
    // The current class's name is live in the input; others use their saved name
    opt.textContent = cls.id === store.currentId ? className({ chartName: chartNameInput.value }) : className(cls.data);
    classSelect.appendChild(opt);
  }
  classSelect.value = store.currentId;
  // With only one class, the button clears it instead
  btnDeleteClass.textContent = store.classes.length > 1 ? "Delete class" : "Clear class";

  roomSelect.innerHTML = "";
  for (const room of store.rooms) {
    const opt = document.createElement("option");
    opt.value = room.id;
    opt.textContent = room.id === activeRoomId ? roomName({ name: roomNameInput.value }) : roomName(room);
    roomSelect.appendChild(opt);
  }
  roomSelect.value = activeRoomId;
  btnDeleteRoom.textContent = store.rooms.length > 1 ? "Delete classroom" : "Clear classroom";
  layoutRoomNameEl.textContent = roomName({ name: roomNameInput.value });
}

function showCurrentClass(status) {
  // Load the current class (in its classroom) after store changes, and save
  activeTool = "seats";
  renderToolBar();
  const note = applyClassData(currentClass().data);
  saveSetup();
  renderClassSelect();
  setStatus(note ? `${status} ${note}` : status);
}

function switchToClass(id) {
  saveSetup();
  store.currentId = id;
  showCurrentClass(`Switched to ${className(currentClass().data)} in ${roomName(currentRoom())}.`);
}

function switchToRoom(roomId) {
  saveSetup();
  currentClass().data.roomId = roomId;
  showCurrentClass(`Showing ${className(currentClass().data)} in ${roomName(store.rooms.find(r => r.id === roomId))}.`);
}

function createClass() {
  // A new class starts in the current classroom, with no students
  saveSetup();
  const id = newClassId();
  store.classes.push({ id, data: { chartName: "New class", roomId: activeRoomId, showColors: showColorsInput.checked } });
  switchToClass(id);
  setStatus(`New class created in ${roomName(currentRoom())}. Type its name and add names.`);
  chartNameInput.focus();
  chartNameInput.select();
}

function deleteCurrentClass() {
  saveSetup();
  const cls = currentClass();
  const name = className(cls.data);

  if (store.classes.length <= 1) {
    if (!confirm(`Clear the class "${name}"? Its names, restrictions, groups and seating charts are removed. ` +
      "The classrooms are kept. This can't be undone (unless you have exported a backup).")) return;
    cls.data = { roomId: activeRoomId, showColors: showColorsInput.checked };
    showCurrentClass("Class cleared.");
    return;
  }

  if (!confirm(`Delete the class "${name}"? This can't be undone (unless you have exported a backup).`)) return;
  const k = store.classes.indexOf(cls);
  store.classes.splice(k, 1);
  store.currentId = store.classes[Math.max(0, k - 1)].id;
  showCurrentClass(`Class deleted. Now showing ${className(currentClass().data)}.`);
}

function createRoom() {
  // A new classroom starts as an empty grid
  saveSetup();
  const room = makeRoom(uniqueName("New classroom", new Set(store.rooms.map(roomName)), ""));
  store.rooms.push(room);
  switchToRoom(room.id);
  setStatus("New classroom created. Name it, then click or drag in the grid to add seats.");
  roomNameInput.focus();
  roomNameInput.select();
}

function deleteCurrentRoom() {
  saveSetup();
  const room = currentRoom();
  const name = roomName(room);

  if (store.rooms.length <= 1) {
    if (!confirm(`Clear the classroom "${name}"? All its seats and table colours are removed, ` +
      "and every class's seating chart for it. This can't be undone (unless you have exported a backup).")) return;
    Object.assign(room, makeRoom(room.name, room.rows, room.cols), { id: room.id });
    for (const cls of store.classes) {
      if (cls.data.charts) delete cls.data.charts[room.id];
    }
    showCurrentClass("Classroom cleared.");
    return;
  }

  if (!confirm(`Delete the classroom "${name}"? Every class's seating chart for it is deleted too. ` +
    "This can't be undone (unless you have exported a backup).")) return;
  const k = store.rooms.indexOf(room);
  store.rooms.splice(k, 1);
  const fallback = store.rooms[Math.max(0, k - 1)].id;
  for (const cls of store.classes) {
    if (cls.data.charts) delete cls.data.charts[room.id];
    if (cls.data.roomId !== room.id) continue;
    // Classes that were showing it move to a classroom where they have a chart, if any
    const withChart = Object.keys(cls.data.charts || {}).find(id => store.rooms.some(x => x.id === id));
    cls.data.roomId = withChart || fallback;
  }
  showCurrentClass(`Classroom deleted. Now showing ${roomName(currentRoom())}.`);
}

function fileSafeName(name) {
  // Letters (any language) and digits kept, everything else becomes "_"
  return name.trim().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
}

function exportBackup(allClasses) {
  // One class (named after it, with the classrooms it has charts for) or everything.
  // The name is stored in the file and used in the file name.
  saveSetup();
  const classes = allClasses ? store.classes : [currentClass()];
  const usedRooms = new Set(classes.flatMap(c => [c.data.roomId, ...Object.keys(c.data.charts || {})]));
  const rooms = allClasses ? store.rooms : store.rooms.filter(r => usedRooms.has(r.id));
  const name = allClasses ? "All classes" : className(currentClass().data);
  const backup = {
    app: BACKUP_APP_ID,
    version: 2,
    name,
    exportedAt: new Date().toISOString(),
    // The teacher PIN is deliberately not exported
    rooms,
    classes: classes.map(c => ({ name: className(c.data), data: c.data }))
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${fileSafeName(name) || "seating"}_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  setStatus(allClasses ? `Exported all ${classes.length} classes and ${rooms.length} classrooms.` : `Exported ${name}.`);
}

function importBackup(text) {
  // Adds the backup's classes (and classrooms) next to the existing ones; nothing is
  // overwritten. A classroom with the same name and layout as an existing one is reused.
  let backup;
  try {
    backup = JSON.parse(text);
  } catch (e) {
    alert("That file isn't a seating backup (it isn't valid JSON).");
    return;
  }
  if (!backup || backup.app !== BACKUP_APP_ID || !Array.isArray(backup.classes)) {
    alert("That file isn't a seating backup from this tool.");
    return;
  }

  saveSetup();

  // Classrooms: backup id -> id here
  const roomIds = new Map();
  for (const r of (Array.isArray(backup.rooms) ? backup.rooms : [])) {
    const room = cleanRoom(r);
    const existing = store.rooms.find(x => roomName(x) === roomName(room) && sameLayout(x, room));
    if (existing) {
      roomIds.set(room.id, existing.id);
      continue;
    }
    const backupId = room.id;
    room.id = newClassId();
    room.name = uniqueName(roomName(room), new Set(store.rooms.map(roomName)), "imported");
    store.rooms.push(room);
    roomIds.set(backupId, room.id);
  }

  // A name that's already taken gets "(imported)", then "(imported 2)", "(imported 3)"...
  // Names added by this import count as taken too, so no two classes end up the same.
  const takenNames = new Set(store.classes.map(c => className(c.data)));
  const added = [];
  for (const c of backup.classes) {
    if (!c || typeof c.data !== "object" || c.data === null) continue;
    let data = Object.assign({}, c.data);
    delete data.teacherPin;

    if (data.charts && typeof data.charts === "object") {
      const charts = {};
      for (const [id, chart] of Object.entries(data.charts)) {
        if (roomIds.has(id)) charts[roomIds.get(id)] = chart;
      }
      data.charts = charts;
      data.roomId = roomIds.get(data.roomId) || Object.keys(charts)[0] || store.rooms[0].id;
    } else {
      data = convertOldClassData(data, className(data)); // backup from before classrooms
    }

    data.chartName = uniqueName(className(data), takenNames, "imported");
    takenNames.add(data.chartName);
    const id = newClassId();
    store.classes.push({ id, data });
    added.push(id);
  }

  if (added.length === 0) {
    alert("The backup didn't contain any classes.");
    return;
  }
  switchToClass(added[0]);
  const from = typeof backup.name === "string" && backup.name ? ` from "${backup.name}"` : "";
  setStatus(`Imported ${added.length} class(es)${from}. Pick one in the Class list.`);
}

// -------------------------
// View switching
// -------------------------

function switchToStudentView() {
  isStudentView = true;
  teacherView.classList.add("hidden");
  studentView.classList.remove("hidden");
  btnToggleMode.textContent = "Switch to Teacher View";
  setStatus("");
  updateGenerateButton();
}

function switchToTeacherView() {
  const savedPin = (pinInput.value || "").trim();
  if (savedPin.length > 0) {
    const entered = prompt("Enter teacher PIN:");
    if (entered === null) return;
    if (entered.trim() !== savedPin) {
      alert("Wrong PIN.");
      return;
    }
  }

  isStudentView = false;
  studentView.classList.add("hidden");
  teacherView.classList.remove("hidden");
  btnToggleMode.textContent = "Switch to Student View";
  updateGenerateButton();

  // Table outlines are measured from the DOM, so anything rendered while the teacher
  // view was hidden (e.g. Generate pressed in Student View) has none. Redraw now.
  renderSeatEditor();
}

// -------------------------
// Generation
// -------------------------

function generateSeating() {
  refreshNamesFromTextarea(); // no-op unless the textarea has unapplied changes
  ensureParallelArrays();
  const seated = presentStudents();

  // Recompute graphs
  const { pairEdges, gapEdges } = recomputeGraphs();
  const pairAdj = buildAdjacencyFromEdges(pairEdges);
  const gapAdj = buildAdjacencyFromEdges(gapEdges);
  const directAdj = buildDirectAdjacency();
  const componentId = computeSeatComponents(pairAdj);

  // Seats
  const seatIndices = [];
  for (let i = 0; i < layout.exists.length; i++) {
    if (layout.exists[i]) seatIndices.push(i);
  }

  if (studentNames.length === 0) {
    alert("Add at least one name.");
    return;
  }
  if (seated.length === 0) {
    alert("Everyone is marked absent.");
    return;
  }
  if (seated.length > seatIndices.length) {
    alert(`Not enough seats. Students present: ${seated.length}, Seats: ${seatIndices.length}.`);
    return;
  }

  // Convert restrictions
  const forbiddenPair = new Set();
  const forbiddenGap = new Set();
  const mustDirect = []; // {a,b}

  for (const r of restrictions) {
    if (!r.a) continue;

    if (r.type === "FIXED_SEAT") {
      // handled via fixedStudentBySeat pins
      continue;
    }

    if (!r.b) continue;
    if (r.a.toLowerCase() === r.b.toLowerCase()) continue;

    const key = namePairKey(r.a, r.b);
    if (r.type === "MUST_DIRECT") {
      // Only when both are here; otherwise it would just block a seat next to the other
      if (!absentStudents.has(r.a) && !absentStudents.has(r.b)) mustDirect.push({ a: r.a, b: r.b });
    }
    else if (r.type === "GAP") forbiddenGap.add(key);
    else forbiddenPair.add(key);
  }

  // Treat GAP-forbidden as also forbidden in desk group (stronger / intuitive)
  function isForbiddenInDeskGroup(a, b) {
    const k = namePairKey(a, b);
    return forbiddenPair.has(k) || forbiddenGap.has(k);
  }

  // Enforce pins from FIXED_SEAT restrictions
  const fixedSet = fixedStudentsFromRestrictions();
  cleanupFixedSeatsAgainstFixedStudents(fixedSet);

  // Solve multiple times and pick the best (fewest lonely)
  const MAX_SOLVES = 40;

  let best = null;
  let bestLonely = Infinity;
  let bestAdjPairs = -Infinity;
  let bestSeatQuality = -Infinity;

  for (let attempt = 0; attempt < MAX_SOLVES; attempt++) {
    const candidate = solveOnce({
      seatIndices,
      studentNames: seated,
      pins: activePins(),
      fixedSet,
      forbiddenGap,
      mustDirect,
      gapAdj,
      directAdj,
      componentId,
      isForbiddenInDeskGroup,
      attempt
    });

    if (!candidate) continue;

    const score = scoreSolution(candidate, directAdj, componentId);
    if (
      score.lonely < bestLonely ||
      (score.lonely === bestLonely && score.adjPairs > bestAdjPairs) ||
      (score.lonely === bestLonely && score.adjPairs === bestAdjPairs && score.seatQuality > bestSeatQuality)
    ) {
      best = candidate;
      bestLonely = score.lonely;
      bestAdjPairs = score.adjPairs;
      bestSeatQuality = score.seatQuality;
      if (bestLonely === 0) break;
    }
  }

  if (!best) {
    alert(
      "No valid seating found with the current layout + restrictions.\n" +
      "Try reducing restrictions or adding more seats."
    );
    return;
  }

  // Publish to students
  publishedAssignment = best.slice();

  // Enforce pinned students in the published output
  enforcePinsOnPublished();

  renderStudentView();
  renderSeatEditor();
  saveSetup();
  setStudentTab("seating");

  if (bestLonely === 0) setStatus("Generated (no lonely clusters).");
  else setStatus(`Generated (lonely clusters: ${bestLonely}).`);
}

function solveOnce(ctx) {
  const seatIndices = ctx.seatIndices.slice();
  const names = ctx.studentNames.slice();
  // Keep some randomness so repeated attempts explore different valid assignments.
  shuffleInPlace(names);

  const assignment = new Array(layout.exists.length).fill("");
  const used = new Set();

  // Pre-place pinned students (ctx.pins: absent students' pins are already left out),
  // but only those in fixedSet
  for (let i = 0; i < ctx.pins.length; i++) {
    const s = ctx.pins[i];
    if (!s) continue;
    if (!layout.exists[i]) continue;
    if (!ctx.fixedSet.has(s)) continue;

    // If the same fixed student appears multiple times, this is impossible
    if (used.has(s)) return null;

    assignment[i] = s;
    used.add(s);
  }

  // Fill seats excluding pinned ones
  const seatsToFill = seatIndices.filter(i => !assignment[i]);

  // Count already-used (pinned) seats per component so we can avoid lonely used clusters
  const alreadyUsedInComponent = new Map();
  for (let i = 0; i < assignment.length; i++) {
    if (!assignment[i]) continue;
    const cid = ctx.componentId[i];
    if (cid === -1) continue;
    alreadyUsedInComponent.set(cid, (alreadyUsedInComponent.get(cid) || 0) + 1);
  }

  // Only place students that are not already pinned
  const remainingStudents = names.filter(n => !used.has(n));

  // If there are more remaining students than available seats, impossible
  if (remainingStudents.length > seatsToFill.length) return null;

  // We only need to assign as many seats as we have remaining students.
  // If there are more seats than students, pick the "best" subset of seats:
  // - closer to front + middle
  // - try to avoid creating isolated seats
  const seatsToAssign = pickSeatSubset(
    seatsToFill,
    remainingStudents.length,
    ctx.directAdj,
    ctx.componentId,
    alreadyUsedInComponent,
    ctx.attempt
  );

  // Place more constrained seats first (helps backtracking).
  seatsToAssign.sort((a, b) => {
    const da = (ctx.directAdj.get(a) || []).length;
    const db = (ctx.directAdj.get(b) || []).length;
    if (da !== db) return da - db;
    return seatPreferenceScore(b) - seatPreferenceScore(a);
  });

  function seatOfStudent(name) {
    for (let i = 0; i < assignment.length; i++) {
      if (assignment[i] === name) return i;
    }
    return -1;
  }

  function areDirectNeighbors(i, j) {
    const nbs = ctx.directAdj.get(i) || [];
    return nbs.includes(j);
  }

  function canPlace(name, seatIdx) {
    // Seat must exist
    if (!layout.exists[seatIdx]) return false;

    // Seat pinned to other student?
    const pinned = ctx.pins[seatIdx];
    if (pinned && pinned !== name) return false;

    // Desk group constraint
    const myComp = ctx.componentId[seatIdx];
    if (myComp !== -1) {
      for (let i = 0; i < assignment.length; i++) {
        const other = assignment[i];
        if (!other) continue;
        if (ctx.componentId[i] !== myComp) continue;
        if (ctx.isForbiddenInDeskGroup(name, other)) return false;
      }
    }

    // Gap constraint
    for (const nb of (ctx.gapAdj.get(seatIdx) || [])) {
      const other = assignment[nb];
      if (!other) continue;
      if (ctx.forbiddenGap.has(namePairKey(name, other))) return false;
    }

    // Must-direct constraints
    for (const p of ctx.mustDirect) {
      let otherName = null;
      if (p.a === name) otherName = p.b;
      else if (p.b === name) otherName = p.a;
      else continue;

      const otherSeat = seatOfStudent(otherName);
      if (otherSeat !== -1) {
        if (!areDirectNeighbors(seatIdx, otherSeat)) return false;
      } else {
        // Reserve at least one adjacent free seat for the other
        const nbs = ctx.directAdj.get(seatIdx) || [];
        let ok = false;

        for (const nb of nbs) {
          if (!layout.exists[nb]) continue;
          if (assignment[nb]) continue;

          const pinnedNb = ctx.pins[nb];
          if (pinnedNb && pinnedNb !== otherName) continue;

          ok = true;
          break;
        }

        if (!ok) return false;
      }
    }

    return true;
  }

  function backtrack(pos) {
    if (pos >= seatsToAssign.length) return true;

    const seatIdx = seatsToAssign[pos];

    for (let i = 0; i < remainingStudents.length; i++) {
      const student = remainingStudents[i];
      if (used.has(student)) continue; // don't reuse a student

      if (canPlace(student, seatIdx)) {
        assignment[seatIdx] = student;
        used.add(student);

        if (backtrack(pos + 1)) return true;

        used.delete(student);
        assignment[seatIdx] = "";
      }
    }

    return false;
  }

  const ok = backtrack(0);
  if (!ok) return null;

  // Make sure pinned fixed students are present (redundant but safe)
  for (let i = 0; i < ctx.pins.length; i++) {
    const s = ctx.pins[i];
    if (!s) continue;
    if (!layout.exists[i]) continue;
    if (!ctx.fixedSet.has(s)) continue;
    assignment[i] = s;
  }

  return assignment;
}

function scoreSolution(assignment, directAdj, componentId) {
  // "Lonely" is evaluated per CLUSTER (connected component of seats), not per seat.
  // If a cluster is used at all, we prefer to have >= 2 students in that cluster.
  // (If a cluster has only 1 seat total, then 1 student there is unavoidable.)

  let lonely = 0; // number of lonely *clusters*
  let adjPairs = 0;
  let seatQuality = 0;

  const usedByComp = new Map();
  const totalByComp = new Map();

  for (let i = 0; i < layout.exists.length; i++) {
    if (!layout.exists[i]) continue;
    const cid = componentId[i];
    if (cid === -1) continue;
    totalByComp.set(cid, (totalByComp.get(cid) || 0) + 1);
  }

  for (let i = 0; i < assignment.length; i++) {
    if (!assignment[i]) continue;
    if (!layout.exists[i]) continue;

    seatQuality += seatPreferenceScore(i);

    const nbs = directAdj.get(i) || [];
    let hasNeighbor = false;

    for (const nb of nbs) {
      if (assignment[nb]) {
        hasNeighbor = true;
        if (nb > i) adjPairs++;
      }
    }

    // Track per-cluster occupancy
    const cid = componentId[i];
    if (cid !== -1) usedByComp.set(cid, (usedByComp.get(cid) || 0) + 1);
  }

  // A used cluster is lonely if it has exactly 1 student but at least 2 seats in total.
  for (const [cid, usedCount] of usedByComp.entries()) {
    const totalSeats = totalByComp.get(cid) || 0;
    if (totalSeats >= 2 && usedCount === 1) lonely++;
  }

  return { lonely, adjPairs, seatQuality };
}

// -------------------------
// Groups
// -------------------------

const GROUP_RULE_TYPES = [
  { value: "APART", label: "Not in the same group" },
  { value: "TOGETHER", label: "Must be in the same group" }
];

function groupSizes(n) {
  // Group sizes for n students from the settings, as even as possible:
  // 26 in groups of 4 -> 4,4,4,4,4,3,3; 26 in 6 groups -> 5,5,4,4,4,4
  if (n <= 0) return [];
  const v = Math.max(1, Math.floor(Number(groupSettings.value) || 1));
  const k = groupSettings.mode === "count" ? Math.min(v, n) : Math.ceil(n / v);
  const base = Math.floor(n / k);
  const extra = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

function describeGroupSizes(sizes) {
  // e.g. "7 groups (5 of 4, 2 of 3)" or "6 groups of 4"
  const counts = new Map();
  for (const size of sizes) counts.set(size, (counts.get(size) || 0) + 1);
  const label = sizes.length === 1 ? "1 group" : `${sizes.length} groups`;
  if (counts.size === 1) return `${label} of ${sizes[0]}`;
  const parts = Array.from(counts.entries()).sort((x, y) => y[0] - x[0]).map(([size, count]) => `${count} of ${size}`);
  return `${label} (${parts.join(", ")})`;
}

function updateGroupSizePreview() {
  const n = presentStudents().length;
  groupSizePreview.textContent = n ? `→ ${describeGroupSizes(groupSizes(n))} for the ${n} students present` : "";
}

function groupConstraints(present) {
  // "Together" rules are merged into clusters (if A-B and B-C, then A, B and C) that
  // must share a group; "apart" is a set of namePairKeys. Only present students count.
  const presentSet = new Set(present);
  const apart = new Set();
  const together = [];
  const both = (r) => r.a && r.b && r.a !== r.b && presentSet.has(r.a) && presentSet.has(r.b);

  for (const r of groupRules) {
    if (!both(r)) continue;
    if (r.type === "TOGETHER") together.push([r.a, r.b]);
    else apart.add(namePairKey(r.a, r.b));
  }
  if (groupSettings.useSeatingRules) {
    for (const r of restrictions) {
      if ((r.type === "PAIR" || r.type === "GAP") && both(r)) apart.add(namePairKey(r.a, r.b));
    }
  }

  const parent = new Map(present.map(n => [n, n]));
  const find = (n) => (parent.get(n) === n ? n : find(parent.get(n)));
  for (const [a, b] of together) parent.set(find(a), find(b));

  const byRoot = new Map();
  for (const n of present) {
    const root = find(n);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(n);
  }
  return { clusters: Array.from(byRoot.values()), apart };
}

function makeGroups(clusters, apart, capacities) {
  // Randomized backtracking: put each "together" cluster into a group that has room
  // and nobody the cluster must be apart from. Returns arrays of names, or null.
  const order = clusters.slice();
  shuffleInPlace(order);
  order.sort((x, y) => y.length - x.length); // big clusters first (stable sort keeps the shuffle)

  const result = capacities.map(() => []);
  const room = capacities.slice();
  let steps = 0;

  const conflicts = (cluster, group) => cluster.some(a => group.some(b => apart.has(namePairKey(a, b))));

  function place(i) {
    if (i === order.length) return true;
    if (++steps > 20000) return false;
    const cluster = order[i];
    const groupOrder = result.map((_, g) => g);
    shuffleInPlace(groupOrder);
    const triedEmpty = new Set(); // empty groups with the same room are interchangeable

    for (const g of groupOrder) {
      if (room[g] < cluster.length || conflicts(cluster, result[g])) continue;
      if (result[g].length === 0) {
        if (triedEmpty.has(room[g])) continue;
        triedEmpty.add(room[g]);
      }
      result[g].push(...cluster);
      room[g] -= cluster.length;
      if (place(i + 1)) return true;
      result[g].splice(result[g].length - cluster.length);
      room[g] += cluster.length;
    }
    return false;
  }

  return place(0) ? result : null;
}

function generateGroups(animate) {
  refreshNamesFromTextarea(); // no-op unless the textarea has unapplied changes
  const present = presentStudents();
  if (present.length === 0) {
    alert(studentNames.length ? "Everyone is marked absent." : "Add at least one name.");
    return;
  }

  const sizes = groupSizes(present.length);
  const maxSize = Math.max(...sizes);
  const { clusters, apart } = groupConstraints(present);

  const tooBig = clusters.find(c => c.length > maxSize);
  if (tooBig) {
    alert(`${tooBig.join(", ")} must all be in the same group, but the groups only have room for ${maxSize}. ` +
      "Make bigger groups or change the rules.");
    return;
  }
  const clash = clusters.find(c => c.some(a => c.some(b => a !== b && apart.has(namePairKey(a, b)))));
  if (clash) {
    alert(`${clash.join(", ")} must be in the same group, but some of them also must not be in the same group. Change the rules.`);
    return;
  }

  // Exact even sizes first; if the "together" rules make that impossible, allow
  // uneven groups (each at most the largest size, none empty).
  let result = null;
  let even = true;
  for (let t = 0; t < 30 && !result; t++) result = makeGroups(clusters, apart, sizes);
  if (!result) {
    even = false;
    for (let t = 0; t < 30 && !result; t++) {
      const r = makeGroups(clusters, apart, sizes.map(() => maxSize));
      if (r && r.every(g => g.length > 0)) result = r;
    }
  }
  if (!result) {
    alert("Couldn't make groups with these rules. Try other group sizes or fewer rules.");
    return;
  }

  for (const g of result) g.sort((x, y) => x.localeCompare(y));
  result.sort((x, y) => y.length - x.length);
  groups = result;
  saveSetup();

  const msg = even
    ? `Made ${describeGroupSizes(groups.map(g => g.length))}.`
    : `Made ${groups.length} groups. Their sizes are uneven because of the "same group" rules.`;
  setStudentTab("groups");
  if (animate) {
    animateGroups(() => setStatus(msg));
  } else {
    renderGroups();
    setStatus(msg);
  }
}

function stopGroupAnimation() {
  if (groupAnimation) clearInterval(groupAnimation);
  groupAnimation = null;
  btnGenerate.disabled = false;
  btnGenerateGroups.disabled = false;
}

function animateGroups(done) {
  // Shuffle the names through the groups for a moment, then show the real groups.
  // Only the display changes; `groups` already holds the result.
  stopGroupAnimation();
  btnGenerate.disabled = true;
  btnGenerateGroups.disabled = true;

  const names = groups.flat();
  const sizes = groups.map(g => g.length);
  let ticks = 0;
  groupAnimation = setInterval(() => {
    if (++ticks > 14) {
      stopGroupAnimation();
      renderGroups({ settle: true });
      done();
      return;
    }
    const shuffled = names.slice();
    shuffleInPlace(shuffled);
    let k = 0;
    const fake = sizes.map(size => shuffled.slice(k, (k += size)));
    renderGroupCards(groupsView, fake, { shuffling: true });
    renderGroupCards(groupsPreview, fake, { shuffling: true });
  }, 90);
}

function renderGroupCards(container, list, opts = {}) {
  container.innerHTML = "";
  container.classList.toggle("shuffling", !!opts.shuffling);
  container.classList.toggle("settle", !!opts.settle);

  if (list.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No groups yet. Press \"Generate groups\".";
    container.appendChild(p);
    return;
  }

  const colors = Object.values(TABLE_COLORS);
  list.forEach((group, i) => {
    const color = colors[i % colors.length];
    const card = document.createElement("div");
    card.className = "group-card";
    card.style.borderColor = color.stroke;

    const head = document.createElement("div");
    head.className = "group-head";
    head.style.background = color.fill;
    head.textContent = `Group ${i + 1}`;
    card.appendChild(head);

    const ul = document.createElement("ul");
    for (const name of group) {
      const li = document.createElement("li");
      li.textContent = name;
      ul.appendChild(li);
    }
    card.appendChild(ul);
    container.appendChild(card);
  });
}

function renderGroups(opts = {}) {
  if (groupAnimation) return; // the animation renders until it's done
  renderGroupCards(groupsPreview, groups, opts);
  renderGroupCards(groupsView, groups, opts);
  updateGroupSizePreview();
}

function syncGroupsWithPresent(oldPresent) {
  // Like syncPublishedWithPresent, for groups: students no longer present leave their
  // group, others stay. Newly present students join, in order of preference: a group
  // with someone they must be with, a group vacated in this update (renames keep their
  // group), then the smallest group without anyone they must be apart from.
  // Returns a status message.
  if (groups.length === 0) return "";
  stopGroupAnimation();
  const present = presentStudents();
  const presentSet = new Set(present);

  const vacated = [];
  groups = groups.map((g, gi) => g.filter(n => {
    if (presentSet.has(n)) return true;
    if (oldPresent.includes(n)) vacated.push(gi);
    return false;
  }));

  const placed = new Set(groups.flat());
  const unplaced = present.filter(n => !placed.has(n));
  const { apart } = groupConstraints(present);
  const groupOf = (name) => groups.findIndex(g => g.includes(name));

  for (const name of unplaced) {
    let gi = -1;
    for (const r of groupRules) {
      if (r.type !== "TOGETHER") continue;
      const other = r.a === name ? r.b : (r.b === name ? r.a : null);
      if (other && groupOf(other) !== -1) {
        gi = groupOf(other);
        break;
      }
    }
    if (gi === -1 && vacated.length) gi = vacated.shift();
    if (gi === -1) {
      const ok = groups.map((g, k) => k).filter(k => !groups[k].some(n => apart.has(namePairKey(n, name))));
      const pool = ok.length ? ok : groups.map((g, k) => k);
      gi = pool.reduce((best, k) => (groups[k].length < groups[best].length ? k : best), pool[0]);
    }
    groups[gi].push(name);
  }

  groups = groups.filter(g => g.length > 0);
  return unplaced.length ? `Added ${unplaced.join(", ")} to a group.` : "";
}

function renderGroupRules() {
  groupRulesList.innerHTML = "";
  const nameOptions = studentNames.map(n => ({ value: n, label: n }));

  for (const rule of groupRules) {
    const row = document.createElement("div");
    row.className = "restriction-row";
    const aSel = makeSelect(nameOptions, rule.a);
    const bSel = makeSelect(nameOptions, rule.b);
    const tSel = makeSelect(GROUP_RULE_TYPES, rule.type);
    const removeBtn = document.createElement("button");
    removeBtn.className = "secondary";
    removeBtn.textContent = "Remove";

    const sync = () => {
      rule.a = aSel.value;
      rule.b = bSel.value;
      rule.type = tSel.value;
      onGroupRulesChanged();
    };
    aSel.addEventListener("change", sync);
    bSel.addEventListener("change", sync);
    tSel.addEventListener("change", sync);
    removeBtn.addEventListener("click", () => {
      groupRules = groupRules.filter(r => r !== rule);
      renderGroupRules();
      onGroupRulesChanged();
    });

    row.append(aSel, bSel, tSel, removeBtn);
    groupRulesList.appendChild(row);
  }
}

function onGroupRulesChanged() {
  // Unlike seating restrictions, this keeps the current groups; they're regenerated on request
  saveSetup();
  if (groups.length) setStatus("Group rules changed. Generate groups again to apply them.");
}

function addGroupRule() {
  if (studentNames.length < 2) {
    alert("Add at least two names first.");
    return;
  }
  groupRules.push({ a: studentNames[0], b: studentNames[1], type: "APART" });
  renderGroupRules();
  saveSetup();
}

function readGroupSettings() {
  groupSettings = {
    mode: groupModeSelect.value === "count" ? "count" : "size",
    value: Math.max(1, Math.min(99, Math.floor(Number(groupValueInput.value) || 1))),
    useSeatingRules: groupUseSeatingInput.checked
  };
  updateGroupSizePreview();
  saveSetup();
}

function setStudentTab(tab) {
  studentTab = tab === "groups" ? "groups" : "seating";
  const isGroups = studentTab === "groups";
  tabSeating.classList.toggle("active", !isGroups);
  tabGroups.classList.toggle("active", isGroups);
  tabSeating.setAttribute("aria-selected", String(!isGroups));
  tabGroups.setAttribute("aria-selected", String(isGroups));
  seatingGrid.classList.toggle("hidden", isGroups);
  groupsView.classList.toggle("hidden", !isGroups);
  btnFlipView.classList.toggle("hidden", isGroups);
  updateGenerateButton();
}

function updateGenerateButton() {
  // In Student View, Generate acts on the tab that's showing
  btnGenerate.textContent = (isStudentView && studentTab === "groups") ? "Generate groups" : "Generate";
}

function downloadGroupsPng() {
  if (groups.length === 0) {
    alert("There are no groups yet. Generate groups first.");
    return;
  }

  const pad = 36;
  const gap = 24;
  const cardW = 400;
  const cardPad = 20;
  const headH = 64;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  // At most 4 cards per row, rows as even as possible
  const cardRows = Math.ceil(groups.length / 4);
  const perRow = Math.ceil(groups.length / cardRows);

  // One name size for all groups: the largest (up to 40px) at which every name fits
  const maxNameW = cardW - cardPad * 2;
  let size = 40;
  for (; size > 18; size--) {
    ctx.font = `600 ${size}px ${PNG_FONT}`;
    if (groups.flat().every(n => ctx.measureText(n).width <= maxNameW)) break;
  }
  const lineH = Math.round(size * 1.35);
  const maxCount = Math.max(...groups.map(g => g.length));
  const cardH = headH + cardPad * 2 + maxCount * lineH;

  const gridW = perRow * cardW + (perRow - 1) * gap;
  const width = pad * 2 + Math.max(gridW, 640);
  const header = layoutPngHeader(ctx, chartTitle(), width - pad * 2);
  const height = pad * 2 + header.height + cardRows * cardH + (cardRows - 1) * gap;

  setupPngCanvas(canvas, ctx, width, height);
  drawPngHeader(ctx, header, `Groups · ${new Date().toLocaleDateString()}`, pad);

  const colors = Object.values(TABLE_COLORS);
  const startX = (width - gridW) / 2;
  const startY = pad + header.height;
  groups.forEach((group, i) => {
    const color = colors[i % colors.length];
    const x = startX + (i % perRow) * (cardW + gap);
    const y = startY + Math.floor(i / perRow) * (cardH + gap);

    ctx.fillStyle = "#ffffff";
    roundRect(ctx, x, y, cardW, cardH, 16);
    ctx.fill();

    // Coloured header band (rounded top corners only)
    ctx.fillStyle = color.fill;
    roundRect(ctx, x, y, cardW, headH, 16);
    ctx.fill();
    ctx.fillRect(x, y + headH - 16, cardW, 16);

    ctx.strokeStyle = color.stroke;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y + headH);
    ctx.lineTo(x + cardW, y + headH);
    ctx.stroke();
    roundRect(ctx, x, y, cardW, cardH, 16);
    ctx.stroke();

    ctx.fillStyle = "#000000";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `700 32px ${PNG_FONT}`;
    ctx.fillText(`Group ${i + 1}`, x + cardPad, y + headH / 2, maxNameW);

    ctx.font = `600 ${size}px ${PNG_FONT}`;
    group.forEach((name, k) => {
      ctx.fillText(name, x + cardPad, y + headH + cardPad + lineH / 2 + k * lineH, maxNameW);
    });
  });

  savePng(canvas, `${fileSafeName(chartNameInput.value) || "class"}_groups`);
}

// -------------------------
// PNG download
// -------------------------

function downloadSeatingAsPng() {
  ensureParallelArrays();

  // Crop to the rows/cols that contain seats, so the chart fills the image.
  let minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
  for (let i = 0; i < layout.exists.length; i++) {
    if (!layout.exists[i]) continue;
    const { r, c } = indexToRC(i, layout.cols);
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  }
  if (maxR === -1) {
    minR = 0; maxR = layout.rows - 1;
    minC = 0; maxC = layout.cols - 1;
  }
  const rows = maxR - minR + 1;
  const cols = maxC - minC + 1;

  // Every seat is the same square, sized for the longest name (between minCell and
  // maxCell; longer names wrap). Rows/cols without any seat are narrow aisles.
  const minCell = 150;
  const maxCell = 260;
  const aisle = 40;
  const namePad = 20;
  const cellSizingFont = 28; // square size is measured at this name size
  const gap = 16;
  const pad = 36;
  const font = "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
  const nameFont = (size) => `600 ${size}px ${font}`;
  const showColors = showColorsInput.checked;

  const title = chartTitle();
  const dateStr = new Date().toLocaleDateString();

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  ctx.font = nameFont(cellSizingFont);
  let cell = minCell;
  const seatedNames = [];
  const rowHasSeat = new Array(rows).fill(false);
  const colHasSeat = new Array(cols).fill(false);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = rcToIndex(minR + r, minC + c, layout.cols);
      if (!layout.exists[idx]) continue;
      rowHasSeat[r] = true;
      colHasSeat[c] = true;
      const name = publishedAssignment[idx] || "";
      if (!name) continue;
      seatedNames.push(name);
      cell = Math.max(cell, ctx.measureText(name).width + namePad);
    }
  }
  cell = Math.min(maxCell, Math.ceil(cell));

  // One name size for the whole chart: the largest at which every name fits its square
  // (wrapped at spaces/hyphens). Names that don't fit even at NAME_FONT_NO_SPLIT_MIN
  // are left out here and shrunk on their own, so they don't make everyone small.
  const box = cell - namePad;
  const fitsAt = (name, size) => {
    ctx.font = nameFont(size);
    const lines = wrapToLines(ctx, name, box, false);
    return !!lines && lines.length * size * NAME_LINE_HEIGHT <= box;
  };
  const sizedNames = seatedNames.filter(n => fitsAt(n, NAME_FONT_NO_SPLIT_MIN));
  let nameSize = NAME_FONT_NO_SPLIT_MIN;
  for (let size = NAME_FONT_MAX; size > NAME_FONT_NO_SPLIT_MIN; size--) {
    if (sizedNames.every(n => fitsAt(n, size))) {
      nameSize = size;
      break;
    }
  }

  // Track positions. Match the student view's flip: the grid is rotated 180°, names
  // stay upright.
  function trackPositions(hasSeat, start) {
    const order = hasSeat.map((_, k) => k);
    if (studentViewFlipped) order.reverse();
    const pos = new Array(hasSeat.length);
    let next = start;
    for (const k of order) {
      pos[k] = next;
      next += (hasSeat[k] ? cell : aisle) + gap;
    }
    return { pos, size: next - gap - start };
  }

  const gridW = trackPositions(colHasSeat, 0).size;
  const gridH = trackPositions(rowHasSeat, 0).size;
  const width = pad * 2 + Math.max(gridW, 640);

  const header = layoutPngHeader(ctx, title, width - pad * 2);
  const height = pad * 2 + header.height + gridH;
  const colX = trackPositions(colHasSeat, (width - gridW) / 2).pos;
  const rowY = trackPositions(rowHasSeat, pad + header.height).pos;

  setupPngCanvas(canvas, ctx, width, height);
  drawPngHeader(ctx, header, dateStr, pad);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = rcToIndex(minR + r, minC + c, layout.cols);
      if (!layout.exists[idx]) continue;
      const x = colX[c];
      const y = rowY[r];

      const color = showColors ? TABLE_COLORS[tableColorBySeat[idx]] : null;
      ctx.fillStyle = color ? color.fill : "#ffffff";
      ctx.strokeStyle = color ? color.stroke : "#222222";
      ctx.lineWidth = 3;

      roundRect(ctx, x, y, cell, cell, 14);
      ctx.fill();
      ctx.stroke();

      const name = publishedAssignment[idx] || "";
      if (!name) continue;
      ctx.fillStyle = "#000000";
      drawFittedName(ctx, name, x + cell / 2, y + cell / 2, box, box, nameFont, nameSize);
    }
  }

  savePng(canvas, fileSafeName(chartNameInput.value) || "seating_chart");
}

// Shared PNG pieces (seating chart and groups)

const PNG_FONT = "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";

function layoutPngHeader(ctx, title, maxWidth) {
  // Title as large as possible, wrapping onto a second line before shrinking
  let size = 72;
  let lines = null;
  for (; size > 24; size--) {
    ctx.font = `700 ${size}px ${PNG_FONT}`;
    lines = wrapToLines(ctx, title, maxWidth, false);
    if (lines && lines.length <= 2) break;
  }
  if (!lines || lines.length > 2) lines = [title];
  const lineH = size * 1.1;
  const subtitleSize = 28;
  const titleH = lines.length * lineH;
  return { title, lines, size, lineH, titleH, subtitleSize, maxWidth, height: titleH + subtitleSize + 44 };
}

function setupPngCanvas(canvas, ctx, width, height) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
}

function drawPngHeader(ctx, header, subtitle, pad) {
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#000000";
  ctx.font = `700 ${header.size}px ${PNG_FONT}`;
  header.lines.forEach((line, k) => {
    ctx.fillText(line, pad, pad + header.size * 0.9 + k * header.lineH, header.maxWidth);
  });

  ctx.fillStyle = "#222222";
  ctx.font = `500 ${header.subtitleSize}px ${PNG_FONT}`;
  ctx.fillText(subtitle, pad, pad + header.titleH + header.subtitleSize + 6);
}

function savePng(canvas, baseName) {
  const a = document.createElement("a");
  a.download = `${baseName}_${new Date().toISOString().slice(0, 10)}.png`;
  a.href = canvas.toDataURL("image/png");
  a.click();
}

const NAME_FONT_MAX = 64;
const NAME_FONT_MIN = 14;
const NAME_LINE_HEIGHT = 1.15;

const NAME_FONT_NO_SPLIT_MIN = 20;

function drawFittedName(ctx, name, cx, cy, maxWidth, maxHeight, nameFont, maxSize) {
  // Largest size (up to maxSize) at which the name, wrapped at spaces and hyphens, fits the box.
  // If a word is too long even at NAME_FONT_NO_SPLIT_MIN, start again from the largest
  // size, now also splitting long words across lines.
  // Last resort: one line at the smallest size, squeezed to the width.
  for (const splitWords of [false, true]) {
    const minSize = splitWords ? NAME_FONT_MIN : NAME_FONT_NO_SPLIT_MIN;
    for (let size = maxSize; size >= minSize; size--) {
      ctx.font = nameFont(size);
      const lines = wrapToLines(ctx, name, maxWidth, splitWords);
      const lineH = size * NAME_LINE_HEIGHT;
      if (!lines || lines.length * lineH > maxHeight) continue;

      const top = cy - ((lines.length - 1) * lineH) / 2;
      lines.forEach((line, k) => ctx.fillText(line, cx, top + k * lineH));
      return;
    }
  }

  ctx.font = nameFont(NAME_FONT_MIN);
  ctx.fillText(name, cx, cy, maxWidth);
}

function wrapToLines(ctx, text, maxWidth, splitWords) {
  // Greedy wrap at spaces, and after hyphens (the hyphen stays on the first line).
  // A piece wider than maxWidth is split across lines with a hyphen if splitWords,
  // otherwise null is returned.
  const pieces = [];
  for (const word of text.trim().split(/\s+/)) {
    word.split(/(?<=-)/).forEach((p, k) => pieces.push({ text: p, sep: k === 0 ? " " : "" }));
  }

  const fits = (s) => ctx.measureText(s).width <= maxWidth;
  const lines = [];
  let line = "";
  for (const p of pieces) {
    const candidate = line ? line + p.sep + p.text : p.text;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    if (fits(p.text)) {
      line = p.text;
      continue;
    }
    if (!splitWords) return null;

    let rest = p.text;
    while (!fits(rest)) {
      let n = rest.length - 1;
      while (n > 1 && !fits(rest.slice(0, n) + "-")) n--;
      lines.push(rest.slice(0, n) + "-");
      rest = rest.slice(n);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// -------------------------
// Wiring
// -------------------------

btnBuildLayout.addEventListener("click", () => {
  const r = Math.max(1, Math.min(30, Number(rowsInput.value || 1)));
  const c = Math.max(1, Math.min(30, Number(colsInput.value || 1)));
  rowsInput.value = r;
  colsInput.value = c;

  const lost = resizeLayout(r, c);
  // Students whose seat fell outside the grid get a free seat, if there is one
  const reseatMsg = (lost > 0 && anyPublishedSeating()) ? syncPublishedWithPresent(presentStudents()) : "";
  updateCounts();
  renderSeatEditor();
  renderStudentView();
  saveSetup();
  setStatus(lost > 0
    ? `Grid resized. ${lost} student(s) were outside the new grid. ${reseatMsg}`
    : "Grid resized — existing seats kept.");
});

seatEditor.addEventListener("pointerdown", startPaint);
seatEditor.addEventListener("pointerover", continuePaint);
window.addEventListener("pointerup", finishPaint);
window.addEventListener("resize", () => {
  // Outline positions depend on the seat sizes
  if (!isStudentView && !paint) renderSeatEditor();
});
window.addEventListener("pointercancel", finishPaint);

chartNameInput.addEventListener("input", () => {
  chartTitleEl.textContent = chartTitle();
  saveSetup();
  renderClassSelect();
});

classSelect.addEventListener("change", () => switchToClass(classSelect.value));
roomSelect.addEventListener("change", () => switchToRoom(roomSelect.value));
roomNameInput.addEventListener("input", () => {
  saveSetup();
  renderClassSelect();
});
btnNewRoom.addEventListener("click", createRoom);
btnDeleteRoom.addEventListener("click", deleteCurrentRoom);
btnNewClass.addEventListener("click", createClass);
btnDeleteClass.addEventListener("click", deleteCurrentClass);
btnExport.addEventListener("click", () => exportBackup(false));
btnExportAll.addEventListener("click", () => exportBackup(true));
btnImport.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const file = importFile.files && importFile.files[0];
  importFile.value = "";
  if (file) importBackup(await file.text());
});

showColorsInput.addEventListener("change", () => {
  renderStudentView();
  saveSetup();
});

btnSave.addEventListener("click", () => {
  saveSetup();
  setStatus("Saved.");
});

btnFlipView.addEventListener("click", () => {
  studentViewFlipped = !studentViewFlipped;
  renderStudentView();
  saveSetup();
});

btnGenerate.addEventListener("click", () => {
  if (isStudentView && studentTab === "groups") generateGroups(true);
  else generateSeating();
});

tabSeating.addEventListener("click", () => setStudentTab("seating"));
tabGroups.addEventListener("click", () => setStudentTab("groups"));

groupValueInput.addEventListener("input", readGroupSettings);
groupModeSelect.addEventListener("change", readGroupSettings);
groupUseSeatingInput.addEventListener("change", readGroupSettings);
btnAddGroupRule.addEventListener("click", addGroupRule);
btnGenerateGroups.addEventListener("click", () => generateGroups(true));

btnToggleMode.addEventListener("click", () => {
  if (isStudentView) switchToTeacherView();
  else switchToStudentView();
});

// Names: counts and duplicate warnings follow typing; the list applies when the box
// loses focus (applying mid-typing would drop restrictions of a half-typed name).
namesInput.addEventListener("input", () => {
  updateCounts();
  saveSetup();
});
namesInput.addEventListener("change", refreshNamesFromTextarea);
namesInput.addEventListener("paste", (e) => {
  const pasted = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
  if (pasted && insertPastedNames(pasted)) e.preventDefault();
});

function insertPastedNames(pasted) {
  // Inserts a tidied version of a pasted class list at the cursor. Returns false when
  // there was nothing to tidy, so the browser's normal paste can go ahead.
  const cleaned = cleanPastedNames(pasted);
  if (cleaned.text === pasted.replace(/\r\n/g, "\n").trim()) return false;

  // Pasting in the middle of a line would merge names, so keep each on its own line
  const before = namesInput.value.slice(0, namesInput.selectionStart);
  const after = namesInput.value.slice(namesInput.selectionEnd);
  const insert = (before && !before.endsWith("\n") ? "\n" : "") + cleaned.text + (after && !after.startsWith("\n") ? "\n" : "");
  // execCommand keeps the browser's undo history; setRangeText is the fallback
  namesInput.focus();
  if (!document.execCommand || !document.execCommand("insertText", false, insert)) {
    namesInput.setRangeText(insert, namesInput.selectionStart, namesInput.selectionEnd, "end");
    namesInput.dispatchEvent(new Event("input"));
  }
  if (cleaned.changes.length) {
    renderNameMessages(`Tidied the pasted list: ${cleaned.changes.join(", ")}. Check it, then click outside the box to apply.`);
  }
  return true;
}

btnAllPresent.addEventListener("click", () => setAbsent(Array.from(absentStudents), false));

btnAddRestriction.addEventListener("click", () => addRestrictionRow(null));

btnClearRestrictions.addEventListener("click", () => {
  restrictionsList.innerHTML = "";
  restrictions = [];
  clearPublishedSeating("Restrictions cleared — cleared seating chart.");

  const fixedSet = fixedStudentsFromRestrictions();
  cleanupFixedSeatsAgainstFixedStudents(fixedSet);

  renderSeatEditor();
  renderStudentView();
  updateCounts();
  saveSetup();
});

btnDownloadPng.addEventListener("click", () => {
  if (studentTab === "groups") downloadGroupsPng();
  else downloadSeatingAsPng();
});

// -------------------------
// Main
// -------------------------

(function main() {
  renderToolBar();
  loadStore();
  pinInput.value = store.teacherPin || "";
  const note = applyClassData(currentClass().data);
  saveSetup();
  renderClassSelect();
  if (note) setStatus(note);

  // Default to student view (as you preferred earlier)
  switchToStudentView();
})();