// Seating Generator v2
// Key changes:
// - Restrictions are rows with dropdowns (A, B, type).
// - Layout is a seat map with gaps; we derive:
//   (1) desk-pair adjacency (distance 1)
//   (2) gap-adjacent adjacency (distance 2 with empty in between)
// - Student view hides restrictions entirely.
//
// Restriction types:
// - "PAIR": students may not be placed on a desk-pair edge
// - "GAP": students may not be placed on a gap-adjacent edge

const STORAGE_KEY = "seating_generator_v2";

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

const namesInput = document.getElementById("namesInput");
const rowsInput = document.getElementById("rowsInput");
const colsInput = document.getElementById("colsInput");
const seatEditor = document.getElementById("seatEditor");
const seatingGrid = document.getElementById("seatingGrid");
const pinInput = document.getElementById("pinInput");
const statusEl = document.getElementById("status");

const pairCountEl = document.getElementById("pairCount");
const gapCountEl = document.getElementById("gapCount");

let isStudentView = false;

let layout = {
  rows: 7,
  cols: 10,
  exists: [] // boolean array rows*cols
};

let studentNames = [];        // parsed from textarea
let restrictions = [];        // array of { a, b, type }
let seatGraphs = {            // computed edges (undirected)
  pairEdges: new Set(),       // "i|j"
  gapEdges: new Set()
};
let lastAssignment = []; // array length rows*cols, "" for empty/unassigned

// -------------------------
// Helpers
// -------------------------

function setStatus(msg) {
  statusEl.textContent = msg;
}

function normalizeName(name) {
  return name.trim();
}

function parseNames(text) {
  const names = text
    .split("\n")
    .map(normalizeName)
    .filter(n => n.length > 0);

  // Optional: de-duplicate while preserving order
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

function edgeKey(i, j) {
  return i < j ? `${i}|${j}` : `${j}|${i}`;
}

function namePairKey(a, b) {
  const aa = a.trim();
  const bb = b.trim();
  if (aa.toLowerCase() < bb.toLowerCase()) return `${aa}|${bb}`;
  return `${bb}|${aa}`;
}

// -------------------------
// Layout
// -------------------------

function initLayout(rows, cols) {
  layout.rows = rows;
  layout.cols = cols;
  layout.exists = new Array(rows * cols).fill(false);

  // Default: make a reasonable starting pattern (a few seats on left)
  // You can comment this out if you want it fully empty on init.
  // Here we just leave it empty, teacher clicks to add seats.
}

function renderSeatEditor() {
  seatEditor.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(60px, 1fr))`;
  seatEditor.innerHTML = "";

  for (let i = 0; i < layout.exists.length; i++) {
    const cell = document.createElement("div");
    cell.className = "seat" + (layout.exists[i] ? "" : " empty");
    cell.textContent = layout.exists[i] ? "Seat" : "";

    cell.addEventListener("click", () => {
  layout.exists[i] = !layout.exists[i];

  // NEW: if we turned this cell into a gap, clear any name assigned there
  if (!layout.exists[i]) {
    if (Array.isArray(lastAssignment) && lastAssignment.length === layout.exists.length) {
      lastAssignment[i] = "";
    }
  }

  renderSeatEditor();
  recomputeGraphsAndCounts();

  // NEW: keep student view consistent if it's open
  if (Array.isArray(lastAssignment) && lastAssignment.length === layout.exists.length) {
    renderSeating(lastAssignment);
  }

  // NEW: persist layout + (possibly updated) assignment
  saveSetup();
});

    seatEditor.appendChild(cell);
  }
}

function renderSeating(assignments) {
  seatingGrid.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(60px, 1fr))`;
  seatingGrid.innerHTML = "";

  for (let i = 0; i < layout.exists.length; i++) {
    const cell = document.createElement("div");
    cell.className = "seat" + (layout.exists[i] ? "" : " empty");
    cell.textContent = layout.exists[i] ? (assignments[i] || "") : "";
    seatingGrid.appendChild(cell);
  }
}

// -------------------------
// Graph derivation (pair + gap adjacency)
// -------------------------

function recomputeGraphsAndCounts() {
  seatGraphs.pairEdges = new Set();
  seatGraphs.gapEdges = new Set();

  const rows = layout.rows;
  const cols = layout.cols;

  function inBounds(r, c) {
    return r >= 0 && r < rows && c >= 0 && c < cols;
  }

  // ---------- PAIR edges (orthogonal seat-to-seat) ----------
  for (let i = 0; i < layout.exists.length; i++) {
    if (!layout.exists[i]) continue;
    const { r, c } = indexToRC(i, cols);

    const direct = [
      { r: r, c: c + 1 },
      { r: r + 1, c: c },
      { r: r, c: c - 1 },
      { r: r - 1, c: c }
    ];

    for (const d of direct) {
      if (!inBounds(d.r, d.c)) continue;
      const j = rcToIndex(d.r, d.c, cols);
      if (layout.exists[j]) {
        seatGraphs.pairEdges.add(edgeKey(i, j));
      }
    }
  }

  // ---------- GAP edges (across one EMPTY cell, including diagonals) ----------
  // For each empty cell, look at all *seat* cells in its 8-neighborhood.
  // Any two seats that touch the same empty cell count as "gap-adjacent".
  for (let e = 0; e < layout.exists.length; e++) {
    if (layout.exists[e]) continue; // only consider empty cells

    const { r, c } = indexToRC(e, cols);

    const seatNeighbors = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (!inBounds(rr, cc)) continue;

        const idx = rcToIndex(rr, cc, cols);
        if (layout.exists[idx]) {
          seatNeighbors.push(idx);
        }
      }
    }

    // Add all pairs among those seat neighbors.
    // (This is what makes Alice gap-adjacent to Göran/August in your example.)
    for (let a = 0; a < seatNeighbors.length; a++) {
      for (let b = a + 1; b < seatNeighbors.length; b++) {
        seatGraphs.gapEdges.add(edgeKey(seatNeighbors[a], seatNeighbors[b]));
      }
    }
  }

  pairCountEl.textContent = String(seatGraphs.pairEdges.size);
  gapCountEl.textContent = String(seatGraphs.gapEdges.size);
}


function computeSeatComponents(pairAdj) {
  // Returns: array componentId per seat index (or -1 for non-seat)
  const comp = new Array(layout.exists.length).fill(-1);
  let nextId = 0;

  for (let i = 0; i < layout.exists.length; i++) {
    if (!layout.exists[i]) continue;
    if (comp[i] !== -1) continue;

    // BFS/DFS
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
// Restrictions UI
// -------------------------

function refreshNamesFromTextarea() {
  const newNames = parseNames(namesInput.value);

  // Keep current restrictions in memory
  const oldRestrictions = restrictions.map(r => ({ a: r.a, b: r.b, type: r.type }));

  studentNames = newNames;

  // Rebuild UI from old restriction objects, but drop ones that no longer match a name
  restrictionsList.innerHTML = "";
  restrictions = [];

  for (const r of oldRestrictions) {
    if (studentNames.includes(r.a) && studentNames.includes(r.b)) {
      addRestrictionRow(r);
    }
  }

  setStatus(`Names updated. Students: ${studentNames.length}`);
}

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

function updateRestrictionDropdownOptions() {
  // Re-render the list rows to ensure dropdowns contain current names.
  // Keep existing restriction selections if possible.
  const old = restrictions.slice();
  restrictionsList.innerHTML = "";

  restrictions = [];
  for (const r of old) {
    addRestrictionRow(r);
  }
}

function addRestrictionRow(initial) {
  if (studentNames.length < 2) {
    alert("Add at least two names first, then click 'Update dropdowns'.");
    return;
  }

  const row = document.createElement("div");
  row.className = "restriction-row";

  const nameOptions = studentNames.map(n => ({ value: n, label: n }));
  const typeOptions = [
    { value: "PAIR", label: "Not in same desk pair" },
    { value: "GAP", label: "Not adjacent across a gap" }
  ];

  const aSel = makeSelect(nameOptions, initial?.a ?? studentNames[0]);
  const bSel = makeSelect(nameOptions, initial?.b ?? studentNames[1]);
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

  function sync() {
    restrictionObj.a = aSel.value;
    restrictionObj.b = bSel.value;
    restrictionObj.type = tSel.value;
  }

  aSel.addEventListener("change", sync);
  bSel.addEventListener("change", sync);
  tSel.addEventListener("change", sync);

  removeBtn.addEventListener("click", () => {
    restrictionsList.removeChild(row);
    restrictions = restrictions.filter(x => x !== restrictionObj);
  });
}

// -------------------------
// Persistence
// -------------------------

function saveSetup() {
  const data = {
    namesText: namesInput.value,
    rows: Number(rowsInput.value),
    cols: Number(colsInput.value),
    layoutExists: Array.isArray(layout.exists) ? layout.exists.slice() : [],
    restrictions: Array.isArray(restrictions)
      ? restrictions.map(r => ({ a: r.a, b: r.b, type: r.type }))
      : [],
    teacherPin: pinInput.value || "",

    // NEW: persist last generated seating
    lastAssignment: Array.isArray(lastAssignment) ? lastAssignment.slice() : []
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  setStatus("Saved.");
}

function loadSetup() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;

  try {
    const data = JSON.parse(raw);

    // 1) Names first
    namesInput.value = data.namesText || "";
    studentNames = parseNames(namesInput.value);

    // 2) Grid size
    const r = Number(data.rows || 7);
    const c = Number(data.cols || 10);
    rowsInput.value = r;
    colsInput.value = c;

    // 3) Layout init + restore seat map
    initLayout(r, c);

    if (Array.isArray(data.layoutExists) && data.layoutExists.length === layout.exists.length) {
      layout.exists = data.layoutExists.slice();
    } else {
      // If sizes don't match (maybe grid was resized), keep default initLayout
      // (Could add a smarter resize-mapping later if needed.)
    }

    // 4) PIN
    pinInput.value = data.teacherPin || "";

    // 5) Render layout + graphs
    renderSeatEditor();
    recomputeGraphsAndCounts();

    // 6) Restore restrictions AFTER we have names
    restrictionsList.innerHTML = "";
    restrictions = [];

    if (Array.isArray(data.restrictions)) {
      for (const r of data.restrictions) {
        // Only keep restrictions where both names still exist
        if (studentNames.includes(r.a) && studentNames.includes(r.b)) {
          addRestrictionRow({ a: r.a, b: r.b, type: r.type || "PAIR" });
        }
      }
    }
    // NEW: restore last generated seating (if it matches the grid)
    lastAssignment = [];
    if (Array.isArray(data.lastAssignment) && data.lastAssignment.length === layout.exists.length) {
    lastAssignment = data.lastAssignment.slice();
    renderSeating(lastAssignment);
    } else {
    // default empty seating display
    lastAssignment = new Array(layout.exists.length).fill("");
    renderSeating(lastAssignment);
    }

    setStatus("Loaded saved setup.");
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

// -------------------------
// Generation (backtracking, randomized)
// -------------------------

function generateSeating() {
  refreshNamesFromTextarea(); // keep dropdowns in sync if names changed

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

  recomputeGraphsAndCounts();

  // Create forbidden name-pairs by type
  const forbiddenPair = new Set(); // namePairKey -> true (PAIR)
  const forbiddenGap = new Set();  // namePairKey -> true (GAP)

  for (const r of restrictions) {
    if (!r.a || !r.b) continue;
    if (r.a.toLowerCase() === r.b.toLowerCase()) continue;

    const key = namePairKey(r.a, r.b);
    if (r.type === "GAP") forbiddenGap.add(key);
    else forbiddenPair.add(key);
  }

  // Assign only as many seats as students; remaining seats stay blank.
  // We'll backtrack over seat positions in random order.
  const seatsToFill = seatIndices.slice();
  shuffleInPlace(seatsToFill);

  const names = studentNames.slice();
  shuffleInPlace(names);

  const assignment = new Array(layout.exists.length).fill("");
  const used = new Set();

  // Precompute adjacency lists based on edge sets for faster checks
  const pairAdj = buildAdjacencyFromEdges(seatGraphs.pairEdges);
  const gapAdj = buildAdjacencyFromEdges(seatGraphs.gapEdges);
  const componentId = computeSeatComponents(pairAdj);

 function canPlace(name, seatIdx) {
  // 1) PAIR restriction applies to ANYONE in the same connected desk group
  const myComp = componentId[seatIdx];
  if (myComp !== -1) {
    // Check all already-placed seats; if same component => not allowed for PAIR-restricted pairs.
    for (let i = 0; i < assignment.length; i++) {
      const other = assignment[i];
      if (!other) continue;
      if (componentId[i] !== myComp) continue;

      if (
            forbiddenPair.has(namePairKey(name, other)) ||
            forbiddenGap.has(namePairKey(name, other))
        ) return false;
    }
  }

  // 2) GAP restriction uses the computed gap adjacency edges
  for (const nb of (gapAdj.get(seatIdx) || [])) {
    const other = assignment[nb];
    if (!other) continue;
    if (forbiddenGap.has(namePairKey(name, other))) return false;
  }

  return true;
}

  function backtrack(pos) {
    if (pos >= names.length) return true;

    const seatIdx = seatsToFill[pos];

    // Try names in random order at each step for variety
    const candidates = names.filter(n => !used.has(n));
    shuffleInPlace(candidates);

    for (const n of candidates) {
      if (!canPlace(n, seatIdx)) continue;

      assignment[seatIdx] = n;
      used.add(n);

      if (backtrack(pos + 1)) return true;

      used.delete(n);
      assignment[seatIdx] = "";
    }

    return false;
  }

  const ok = backtrack(0);

  if (!ok) {
    alert(
      "No valid seating found with the current layout + restrictions.\n" +
      "Try reducing restrictions or adjusting the seat layout / gaps."
    );
    return;
  }

  lastAssignment = assignment.slice();
  renderSeating(lastAssignment);
  setStatus("Generated.");
  saveSetup(); // persist immediately
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
// Wiring
// -------------------------

btnBuildLayout.addEventListener("click", () => {
  const r = Math.max(1, Math.min(30, Number(rowsInput.value || 1)));
  const c = Math.max(1, Math.min(30, Number(colsInput.value || 1)));
  rowsInput.value = r;
  colsInput.value = c;

  initLayout(r, c);

  lastAssignment = new Array(layout.exists.length).fill("");
  renderSeating(lastAssignment);

  renderSeatEditor();
  recomputeGraphsAndCounts();
  setStatus("Grid rebuilt. Click cells to place seats and gaps.");

  // NEW: persist the new grid size + cleared assignment
  saveSetup();
});

namesInput.addEventListener("input", () => {
  // don't spam localStorage on every keystroke in huge lists
  // but for typical classes this is fine
  saveSetup();
});

pinInput.addEventListener("input", saveSetup);

rowsInput.addEventListener("change", saveSetup);
colsInput.addEventListener("change", saveSetup);

btnSave.addEventListener("click", saveSetup);
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
});

(function main() {
  const loaded = loadSetup();

  if (!loaded) {
    initLayout(Number(rowsInput.value), Number(colsInput.value));
    renderSeatEditor();
    recomputeGraphsAndCounts();
    studentNames = parseNames(namesInput.value);

    // Make sure we have an assignment array for the current grid
    lastAssignment = new Array(layout.exists.length).fill("");
    renderSeating(lastAssignment);
  }


  switchToStudentView();
})();