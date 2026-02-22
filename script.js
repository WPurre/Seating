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

  for (let i = 0; i < layout.exists.length; i++) {
    const cell = document.createElement("div");
    cell.className = "seat" + (layout.exists[i] ? "" : " empty");
    cell.textContent = layout.exists[i] ? (publishedAssignment[i] || "") : "";
    seatingGrid.appendChild(cell);
  }
}

function renderSeatEditor() {
  ensureParallelArrays();

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
    { value: "PAIR", label: "Not in same connected desk group" },
    { value: "GAP", label: "Not adjacent across a gap" },
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
      isForbiddenInDeskGroup
    });

    if (!candidate) continue;

    const score = scoreSolution(candidate, directAdj);
    if (score.lonely < bestLonely || (score.lonely === bestLonely && score.adjPairs > bestAdjPairs)) {
      best = candidate;
      bestLonely = score.lonely;
      bestAdjPairs = score.adjPairs;
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

  if (bestLonely === 0) setStatus("Generated (no lonely students).");
  else setStatus(`Generated (lonely students: ${bestLonely}).`);
}

function solveOnce(ctx) {
  const seatIndices = ctx.seatIndices.slice();
  const names = ctx.studentNames.slice();
  shuffleInPlace(seatIndices);
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

  // Only place students that are not already pinned
  const remainingStudents = names.filter(n => !used.has(n));

  // If there are more remaining students than available seats, impossible
  if (remainingStudents.length > seatsToFill.length) return null;

  // We only need to assign as many seats as we have remaining students
  const seatsToAssign = seatsToFill.slice(0, remainingStudents.length);

  // Heuristic: fill more constrained seats first (keep it on the seats we actually assign)
  seatsToAssign.sort((a, b) => {
    const da = (ctx.directAdj.get(a) || []).length;
    const db = (ctx.directAdj.get(b) || []).length;
    return da - db;
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

function scoreSolution(assignment, directAdj) {
  let lonely = 0;
  let adjPairs = 0;

  for (let i = 0; i < assignment.length; i++) {
    if (!assignment[i]) continue;
    if (!layout.exists[i]) continue;

    const nbs = directAdj.get(i) || [];
    let hasNeighbor = false;

    for (const nb of nbs) {
      if (assignment[nb]) {
        hasNeighbor = true;
        if (nb > i) adjPairs++;
      }
    }

    if (!hasNeighbor) lonely++;
  }

  return { lonely, adjPairs };
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