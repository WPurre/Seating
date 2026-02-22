// Seating Generator v4 (mode-free UX)
// - Click empty cell => add seat
// - Click seat cell => remove seat
// - Drag & drop swaps/moves students (teacher view)
// - Restrictions: PAIR, GAP, MUST_DIRECT, FIXED_SEAT ("Specific seat")
// - FIXED_SEAT students are pre-placed in teacher view only (draft preview)
// - Generate publishes a seating chart to student view
// - Changing names or restrictions clears the published seating
// - Generation prefers fewer "lonely" students if possible

const STORAGE_KEY = "seating_generator_v4";

// -------------------------
// DOM
// -------------------------

const teacherView = document.getElementById("teacherView");
const studentView = document.getElementById("studentView");

const btnToggleMode = document.getElementById("btnToggleMode");
const btnGenerate = document.getElementById("btnGenerate");
const btnBuildLayout = document.getElementById("btnBuildLayout");
const btnSave = document.getElementById("btnSave");
const btnUpdateNames = document.getElementById("btnUpdateNames");

const btnAddRestriction = document.getElementById("btnAddRestriction");
const btnClearRestrictions = document.getElementById("btnClearRestrictions");
const restrictionsList = document.getElementById("restrictionsList");

const btnDownloadPng = document.getElementById("btnDownloadPng");
const btnFlipView = document.getElementById("btnFlipView");

const namesInput = document.getElementById("namesInput");
const rowsInput = document.getElementById("rowsInput");
const colsInput = document.getElementById("colsInput");
const seatEditor = document.getElementById("seatEditor");
const seatingGrid = document.getElementById("seatingGrid");
const pinInput = document.getElementById("pinInput");
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

let studentNames = [];   // parsed from textarea
let restrictions = [];   // array of {a,b,type}



// Published seating shown to students
let publishedAssignment = []; // length rows*cols, "" if none

// Fixed seat assignments: seatIndex -> studentName (only for FIXED_SEAT students)
let fixedStudentBySeat = [];  // length rows*cols, "" if none

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

  // Slight outward padding so the outline is consistently "centered" vs gaps
  // and doesn't touch the seat borders too tightly.
  const pad = 5;

  function xEdge(x) {
    return left0 + x * stepX - pad;
  }

  function yEdge(y) {
    return top0 + y * stepY - pad;
  }

  // And since we subtracted pad on the "top/left" edges, we should add it back
  // by expanding the viewBox slightly so strokes aren't clipped at borders.
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
}

function updateCounts() {
  const seatCount = layout.exists.filter(x => x).length;
  const studentCount = parseNames(namesInput.value).length;

  seatCountEl.textContent = String(seatCount);
  studentCountEl.textContent = String(studentCount);
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

  // Overlay fixed students into the teacher draft view
  for (let i = 0; i < fixedStudentBySeat.length; i++) {
    const s = fixedStudentBySeat[i];
    if (!s) continue;
    if (!layout.exists[i]) continue;
    draft[i] = s;
  }
}

// -------------------------
// Rendering
// -------------------------

function renderStudentView() {
  ensureParallelArrays();
  seatingGrid.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(60px, 1fr))`;
  seatingGrid.innerHTML = "";
  seatingGrid.classList.toggle("flipped", !!studentViewFlipped);

  for (let i = 0; i < layout.exists.length; i++) {
    const cell = document.createElement("div");
    cell.className = "seat" + (layout.exists[i] ? "" : " empty");
    cell.textContent = layout.exists[i] ? (publishedAssignment[i] || "") : "";
    seatingGrid.appendChild(cell);
  }
}

function renderSeatEditor() {
  ensureParallelArrays();

  // Teacher-only grouping visuals: highlight adjacent "tables" (connected seat groups)
  const { pairEdges } = recomputeGraphs();
  const pairAdj = buildAdjacencyFromEdges(pairEdges);
  const compId = computeSeatComponents(pairAdj);

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

    // Gap cell: clicking adds a seat
    if (!layout.exists[i]) {
      cell.className = "seat empty";
      cell.textContent = "";

      cell.addEventListener("click", () => {
        layout.exists[i] = true;

        // Ensure fixed pins and published seating remain consistent
        ensureParallelArrays();
        // If a seat is created, no need to change published assignment
        // but we should re-render so fixed students can auto-appear
        updateCounts();
        renderSeatEditor();
        renderStudentView();
        saveSetup();
        setStatus("Seat added.");
      });

      seatEditor.appendChild(cell);
      continue;
    }

    // Seat cell: show draft name or "Seat"
    cell.className = "seat";

    // Mark group membership for teacher view (visualized by SVG overlay)
    const cid = compId[i];
    if (cid !== -1) {
      cell.classList.add("group");
      const nbs = pairAdj.get(i) || [];
      if (nbs.length === 0) cell.classList.add("isolated");
    }

    const pinned = fixedStudentBySeat[i] || "";
    const nameHere = draft[i] || "";

    cell.textContent = nameHere ? nameHere : "Seat";
    if (pinned) cell.textContent += " 📌";

    // Drag if there is a student shown here
    cell.draggable = !!nameHere;
    if (nameHere) {
      cell.addEventListener("dragstart", (e) => onDragStartSeat(e, i));
      cell.addEventListener("dragover", (e) => e.preventDefault());
      cell.addEventListener("drop", (e) => onDropSeat(e, i));
    } else {
      // allow drop into empty seat too
      cell.addEventListener("dragover", (e) => e.preventDefault());
      cell.addEventListener("drop", (e) => onDropSeat(e, i));
    }

    // Click seat => remove seat
    cell.addEventListener("click", () => {
      // Removing a seat clears any published assignment and any pin at that seat.
      layout.exists[i] = false;
      ensureParallelArrays();

      if (publishedAssignment[i]) publishedAssignment[i] = "";
      if (fixedStudentBySeat[i]) fixedStudentBySeat[i] = "";

      updateCounts();
      renderSeatEditor();
      renderStudentView();
      saveSetup();
      setStatus("Seat removed.");
    });

    seatEditor.appendChild(cell);
  }

  // Draw SVG cluster outlines last (so it can bridge grid gaps)
  drawTeacherClusterOutlines(seatEditor, pairAdj, compId);
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

  // If target seat is pinned to some other fixed student, block
  const pinnedTo = fixedStudentBySeat[toIdx];
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
    const pinned = fixedStudentBySeat[toIdx];
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
  for (const s of fixedSet) removeStudentFromPublished(s);

  for (let i = 0; i < fixedStudentBySeat.length; i++) {
    const s = fixedStudentBySeat[i];
    if (!s) continue;
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
  studentNames = parseNames(namesInput.value);

  // If names change => clear published seating
  clearPublishedSeating("Names changed — cleared seating chart.");

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

  updateCounts();
  renderSeatEditor();
  renderStudentView();
  saveSetup();
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

function saveSetup() {
  ensureParallelArrays();
  const data = {
    namesText: namesInput.value,
    rows: Number(rowsInput.value),
    cols: Number(colsInput.value),
    layoutExists: layout.exists.slice(),
    restrictions: restrictions.map(r => ({ a: r.a, b: r.b, type: r.type })),
    teacherPin: pinInput.value || "",
    publishedAssignment: publishedAssignment.slice(),
    fixedStudentBySeat: fixedStudentBySeat.slice()
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function loadSetup() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;

  try {
    const data = JSON.parse(raw);

    namesInput.value = data.namesText || "";
    studentNames = parseNames(namesInput.value);

    const r = Number(data.rows || 7);
    const c = Number(data.cols || 10);
    rowsInput.value = r;
    colsInput.value = c;

    initLayout(r, c);

    if (Array.isArray(data.layoutExists) && data.layoutExists.length === layout.exists.length) {
      layout.exists = data.layoutExists.slice();
    }

    if (Array.isArray(data.fixedStudentBySeat) && data.fixedStudentBySeat.length === layout.exists.length) {
      fixedStudentBySeat = data.fixedStudentBySeat.slice();
    } else {
      fixedStudentBySeat = new Array(layout.exists.length).fill("");
    }

    if (Array.isArray(data.publishedAssignment) && data.publishedAssignment.length === layout.exists.length) {
      publishedAssignment = data.publishedAssignment.slice();
    } else {
      publishedAssignment = new Array(layout.exists.length).fill("");
    }

    pinInput.value = data.teacherPin || "";

    // Restore restrictions
    restrictionsList.innerHTML = "";
    restrictions = [];
    if (Array.isArray(data.restrictions)) {
      for (const r0 of data.restrictions) {
        if (!r0.a || !studentNames.includes(r0.a)) continue;

        if (r0.type === "FIXED_SEAT") {
          addRestrictionRow({ a: r0.a, b: "", type: "FIXED_SEAT" });
          continue;
        }

        if (!r0.b || !studentNames.includes(r0.b)) continue;
        addRestrictionRow({ a: r0.a, b: r0.b, type: r0.type || "PAIR" });
      }
    }

    // Cleanup pins/assignments vs current names and fixed set
    ensureParallelArrays();
    const fixedSet = fixedStudentsFromRestrictions();
    cleanupFixedSeatsAgainstFixedStudents(fixedSet);

    // Remove any names in published assignment that no longer exist
    for (let i = 0; i < publishedAssignment.length; i++) {
      if (publishedAssignment[i] && !studentNames.includes(publishedAssignment[i])) {
        publishedAssignment[i] = "";
      }
    }

    updateCounts();
    renderSeatEditor();
    renderStudentView();
    setStatus("Loaded saved setup.");
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
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
}

// -------------------------
// Generation
// -------------------------

function generateSeating() {
  studentNames = parseNames(namesInput.value);
  updateCounts();
  ensureParallelArrays();

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
  if (studentNames.length > seatIndices.length) {
    alert(`Not enough seats. Students: ${studentNames.length}, Seats: ${seatIndices.length}.`);
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
    if (r.type === "MUST_DIRECT") mustDirect.push({ a: r.a, b: r.b });
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
      studentNames,
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

  // Pre-place pinned students (fixedStudentBySeat), but only those in fixedSet
  for (let i = 0; i < fixedStudentBySeat.length; i++) {
    const s = fixedStudentBySeat[i];
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
    const pinned = fixedStudentBySeat[seatIdx];
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

          const pinnedNb = fixedStudentBySeat[nb];
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
  for (let i = 0; i < fixedStudentBySeat.length; i++) {
    const s = fixedStudentBySeat[i];
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
// PNG download
// -------------------------

function downloadSeatingAsPng() {
  ensureParallelArrays();

  const rows = layout.rows;
  const cols = layout.cols;

  const cellW = 220;
  const cellH = 80;
  const gap = 14;
  const pad = 30;
  const headerH = 70;

  const title = "Seating chart";
  const dateStr = new Date().toLocaleString();

  const width = pad * 2 + cols * cellW + (cols - 1) * gap;
  const height = pad * 2 + headerH + rows * cellH + (rows - 1) * gap;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#111111";
  ctx.font = "600 24px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
  ctx.fillText(title, pad, pad + 26);

  ctx.fillStyle = "#444444";
  ctx.font = "400 14px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
  ctx.fillText(dateStr, pad, pad + 50);

  const startY = pad + headerH;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const x = pad + c * (cellW + gap);
      const y = startY + r * (cellH + gap);

      if (!layout.exists[idx]) continue;

      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#d5d9e3";
      ctx.lineWidth = 2;

      roundRect(ctx, x, y, cellW, cellH, 14);
      ctx.fill();
      ctx.stroke();

      const name = publishedAssignment[idx] || "";
      ctx.fillStyle = "#111111";

      const maxTextWidth = cellW - 20;
      let fontSize = 18;
      while (fontSize > 12) {
        ctx.font = `500 ${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
        if (ctx.measureText(name).width <= maxTextWidth) break;
        fontSize--;
      }

      ctx.fillText(name, x + cellW / 2, y + cellH / 2);
    }
  }

  const a = document.createElement("a");
  const safeDate = new Date().toISOString().slice(0, 10);
  a.download = `seating_chart_${safeDate}.png`;
  a.href = canvas.toDataURL("image/png");
  a.click();
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

  initLayout(r, c);
  updateCounts();
  renderSeatEditor();
  renderStudentView();
  saveSetup();
  setStatus("Grid rebuilt.");
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

btnGenerate.addEventListener("click", generateSeating);

btnToggleMode.addEventListener("click", () => {
  if (isStudentView) switchToTeacherView();
  else switchToStudentView();
});

btnUpdateNames.addEventListener("click", refreshNamesFromTextarea);

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

btnDownloadPng.addEventListener("click", downloadSeatingAsPng);

// -------------------------
// Main
// -------------------------

(function main() {
  const loaded = loadSetup();

  if (!loaded) {
    initLayout(Number(rowsInput.value), Number(colsInput.value));
    studentNames = parseNames(namesInput.value);
    updateCounts();
    renderSeatEditor();
    renderStudentView();
  }

  // Default to student view (as you preferred earlier)
  switchToStudentView();
})();