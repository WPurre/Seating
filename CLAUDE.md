# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A classroom seating-chart generator. It is a static, dependency-free web app made of three files: `index.html`, `style.css`, and `script.js`. It has no build step, package manager, linter, or test suite. To run it, open `index.html` in a browser, or serve the directory with something like `python3 -m http.server`. All state lives in `localStorage`.

## Architecture (`script.js`)

Everything is plain global functions and module-level mutable state. Sections are marked with `// ----` banner comments.

### Core state and the grid model
- `layout = { rows, cols, exists[] }`: a flat `rows*cols` boolean array. `true` means a seat and `false` means an empty cell, which acts as an aisle or gap. Cells are addressed by flat index; convert with `indexToRC` and `rcToIndex`.
- `publishedAssignment[]`, `fixedStudentBySeat[]` (student name or `""`) and `tableColorBySeat[]` (a `TABLE_COLORS` key or `""`) are arrays parallel to `layout.exists`. `ensureParallelArrays()` resets them whenever their length doesn't match. A new parallel array must be added there, in `initLayout`/`resizeLayout`, in `removeSeat`, and in save/load.
- Table colours are stored per seat. `normalizeTableColors` (called from `renderSeatEditor`) gives every seat of a table the table's majority colour, so seats added to a coloured table inherit its colour.
- Names: `studentNames` is applied from the textarea on its `change` event (`refreshNamesFromTextarea`), not while typing, because applying a half-typed rename would drop that student's restrictions. Counts and duplicate warnings (`findDuplicateNames`) update live. `cleanPastedNames` tidies pasted class lists.
- `absentStudents` (a Set of names) keeps a student's restrictions and pins but leaves them unseated. Use `presentStudents()` for anyone being seated and `activePins()` for pins: an absent student's pinned seat is free while they're away.
- `restrictions[]` holds `{a, b, type}` objects. Each one is bound by reference to a DOM row created in `addRestrictionRow`. To rebuild the list, clear both `restrictionsList.innerHTML` and `restrictions`, then call `addRestrictionRow` again for each entry. Never push to the array directly.

### Two views
- **Teacher view** (`renderSeatEditor`): each render draws an SVG overlay (`.cluster-overlay`) that outlines the "tables". Editing is click-and-drag "painting" via pointer events delegated on `#seatEditor` (`startPaint` / `continuePaint` / `finishPaint`). It patches cells in the DOM while dragging and does the full re-render on pointerup. `activeTool` picks what a drag does: `"seats"` adds seats when started on an empty cell and removes them when started on a seat, a colour key colours every table touched, and `"none"` clears colour. A seat showing a student is `draggable` (HTML5 drag and drop, which moves the student) only under the seats tool. `startPaint` ignores draggable cells so the two kinds of drag don't collide.
- **Student view** (`renderStudentView`): shows only `publishedAssignment`, with the chart name as the heading. All cells are equal squares. The grid is `width: fit-content` with `1fr` columns, so every column takes the widest seat's width; seats are capped at 150px, after which names wrap. No outline overlay is drawn here.
- Teacher-view seat names are cut off with an ellipsis (`.seat-name` span); the full name shows on hover. The optional teacher PIN guards switching back to the teacher view. On page load the app always starts in the student view.
- The teacher view displays a *draft*: `publishedAssignment` with FIXED_SEAT students overlaid by `ensureFixedStudentsVisibleInTeacherDraft`. Pinned students therefore appear in the teacher view before anything is generated, but not in the student view.

### Derived graphs (`recomputeGraphs`, `buildDirectAdjacency`, `computeSeatComponents`)
- **Pair edges / direct adjacency**: orthogonally adjacent seats.
- **Components (clusters, "tables")**: connected groups of seats under orthogonal adjacency. The words "table", "desk group", and "cluster" all mean a component.
- **Gap edges**: two seats that both touch the same empty cell within its 8-neighbourhood. These count as "adjacent tables".

### Restriction types and how the solver enforces them
| type | UI label | constraint |
|---|---|---|
| `PAIR` | Not at same table | not in the same component |
| `GAP` | Not at adjacent tables | not across a gap edge, **and** not in the same component |
| `MUST_DIRECT` | Must be directly adjacent | orthogonal neighbours |
| `FIXED_SEAT` | Specific seat | student is pinned via `fixedStudentBySeat`; `b` unused |

Names are compared case-insensitively. `parseNames` dedupes them case-insensitively, and `namePairKey` builds a canonical pair key.

### Generation (`generateSeating` → `solveOnce` → `scoreSolution`)
1. Runs up to `MAX_SOLVES` (40) randomized attempts. Each attempt shuffles the names, pre-places pinned students, and then picks which seats to fill with `pickSeatSubset` when there are more seats than students.
2. `pickSeatSubset` prefers front-row, centre seats (`seatPreferenceScore`). It also tries to avoid "lonely" clusters, meaning a used component with exactly one student even though the component has two or more seats.
3. A backtracking fill (`canPlace`) enforces the constraints in the table above.
4. The best candidate wins, compared in this order: fewest lonely clusters, then most adjacent pairs, then highest seat quality. Once found, it is written to `publishedAssignment` and `enforcePinsOnPublished()` is applied.

### Invariants and behaviours to preserve
- Any restriction change clears the published seating (`clearPublishedSeating`). Name changes, attendance changes and grid resizes do **not**; they call `syncPublishedWithPresent`. With it, everyone else stays put and students no longer present free their seats. Active pins are applied first, so a returning pinned student takes back their seat and whoever borrowed it is reseated. Unseated students then take a seat vacated in the same update (so a rename keeps the seat), then the best free seat according to the lonely-cluster rules.
- `resizeLayout` keeps everything that still fits. Rows and columns are added or removed at the bottom/right.
- Dragging in the teacher view edits `publishedAssignment` only when a published seating already exists. Otherwise it only moves pins.
- Most mutations end with the same sequence: `updateCounts()`, `renderSeatEditor()`, `renderStudentView()`, `saveSetup()`, and `setStatus(...)`.

### Persistence and classes
- `store = { currentId, teacherPin, classes: [{ id, data }] }` lives in `localStorage` under `STORE_KEY`. Each `data` is one class, as built by `buildClassData`. The teacher PIN is shared by all classes.
- `saveSetup` writes the current class into `store` and persists it. `applyClassData` loads a class into the UI and state; it's also used for new and imported classes, so it must tolerate missing or bad fields.
- `loadStore` migrates the old single-class save (`STORAGE_KEY`) on first run.
- The class name is `chartName`, which is also the chart title.
- Export/import writes and reads `{ app: "seating-generator", version, name, classes: [{ name, data }] }`. `exportBackup(false)` exports the current class and `exportBackup(true)` exports all of them. `name` (the class name, or "All classes") is also used in the filename, via `fileSafeName`. Import adds classes and never overwrites. The PIN is never exported.
- `applyClassData` throws away saved arrays whose lengths don't match `rows*cols`. For that reason `rows` and `cols` are saved from `layout`, never from the inputs, which may hold an unapplied resize.
- The student-view flip state (`studentViewFlipped`) is **not** saved.

### Rendering notes
- `drawClusterOutlinesSvg` positions the outlines from real DOM rects plus the computed CSS grid `gap`. Changing `.seat-grid` gap, padding, or border in `style.css` affects the outline alignment. A render while the teacher view is hidden draws no outlines, so `switchToTeacherView` and window resize call `renderSeatEditor` again. In `drawTeacherClusterOutlines`, everything after the early `return;` is dead legacy code.
- The student-view flip rotates the grid 180° in CSS and counter-rotates each `.seat` so names stay upright.
- `downloadSeatingAsPng` redraws the chart on a `<canvas>` from `layout`, `publishedAssignment` and `tableColorBySeat`, cropped to the rows and columns that contain seats. Every seat is the same square, sized for the longest name up to a cap. Rows and columns with no seats shrink to narrow aisles. All names share one font size: the largest at which every name fits its square. Names that don't fit even at `NAME_FONT_NO_SPLIT_MIN` are left out of that calculation and shrunk or split on their own by `drawFittedName` and `wrapToLines`. It uses the chart name as the title and filename. It does not take a DOM snapshot, so it applies `studentViewFlipped` itself by mirroring the row and column positions.

## Testing

There is no test suite. One approach that works is a throwaway copy of `index.html` that also loads a test script after `script.js`. The top-level `let` state and functions are global, so the script can drive them, dispatching `PointerEvent`s for painting. Render it with `firefox --headless --screenshot`. The screenshot is taken on load, so keep test scripts synchronous. Firefox empties `clipboardData` on synthetic paste events, so test paste handling through `insertPastedNames`. If Firefox is the snap build, it can't read `/tmp`, so put the copy under `~/snap/firefox/common/`.
