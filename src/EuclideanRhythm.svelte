<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  // ── IndexedDB helpers ────────────────────────────────────────────────────────
  const IDB_NAME = 'euc-samples';
  const IDB_STORE = 'samples';

  function openIDB(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = (e) => res((e.target as IDBOpenDBRequest).result);
      req.onerror = (e) => rej((e.target as IDBOpenDBRequest).error);
    });
  }

  async function idbPut(key: number, val: ArrayBuffer): Promise<void> {
    const db = await openIDB();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = (e) => rej((e.target as IDBTransaction).error);
    });
  }

  async function idbGet(key: number): Promise<ArrayBuffer | null> {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = (e) => { db.close(); res((e.target as IDBRequest).result ?? null); };
      req.onerror = (e) => rej((e.target as IDBRequest).error);
    });
  }

  async function idbDelete(key: number): Promise<void> {
    const db = await openIDB();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = (e) => rej((e.target as IDBTransaction).error);
    });
  }

  // ── localStorage helpers ─────────────────────────────────────────────────────
  const LS_KEY = 'euc-state';

  interface SavedLane {
    id: number; euclid: EP; ops: Op[]; sampleName: string; hasSample: boolean;
  }
  interface SavedState { bpm: number; lanes: SavedLane[]; }

  function readSaved(): SavedState | null {
    if (typeof localStorage === 'undefined') return null;
    try { return JSON.parse(localStorage.getItem(LS_KEY) ?? 'null'); }
    catch { return null; }
  }

  interface EP { len: number; steps: number; div: number; offset: number; }
  type OpType = 'invert' | 'add' | 'subtract' | 'multiply' | 'chain';
  interface Op { type: OpType; params: EP; }
  interface Lane { id: number; euclid: EP; ops: Op[]; sample: AudioBuffer | null; sampleName: string; }
  interface LaneRt { segIdx: number; stepIdx: number; nextStepTime: number; }

  interface FlowNode {
    kind: 'src' | OpType;
    params: EP | null;
    pattern: boolean[];
    flatIdx: number | null;   // index into lane.ops, or null for the SRC node
    segIdx: number;           // which playback segment this node belongs to
    isSegTerminal: boolean;   // last node of its segment (its pattern is what plays)
  }

  function bjorklund(k: number, n: number): boolean[] {
    n = n | 0; k = Math.max(0, Math.min(k | 0, n));
    if (n <= 0) return [];
    const p: boolean[] = new Array(n);
    for (let i = 0; i < n; i++)
      p[i] = Math.floor((i * k) / n) > Math.floor(((i - 1) * k) / n);
    return p;
  }

  function rotate(p: boolean[], off: number): boolean[] {
    const n = p.length; if (!n) return [];
    const o = ((off | 0) % n + n) % n;
    return o === 0 ? p.slice() : [...p.slice(o), ...p.slice(0, o)];
  }

  function evalEP(p: EP): boolean[] {
    return rotate(bjorklund(p.steps, p.len), p.offset);
  }

  function applyPatternOp(op: Op, cur: boolean[]): boolean[] {
    if (op.type === 'invert') return cur.map(b => !b);
    const b = evalEP(op.params);
    return cur.map((a, i) => {
      const bi = b[i % b.length] ?? false;
      if (op.type === 'add') return a || bi;
      if (op.type === 'subtract') return a && !bi;
      return a && bi;
    });
  }

  function evalPipeline(euclid: EP, ops: Op[]): { pattern: boolean[]; div: number }[] {
    const result: { pattern: boolean[]; div: number }[] = [];
    let cur = evalEP(euclid), div = euclid.div;
    for (const op of ops) {
      if (op.type === 'chain') {
        result.push({ pattern: cur, div });
        cur = evalEP(op.params);
        div = op.params.div;
      } else {
        cur = applyPatternOp(op, cur);
      }
    }
    result.push({ pattern: cur, div });
    return result;
  }

  function getFlatNodes(euclid: EP, ops: Op[]): FlowNode[] {
    const nodes: FlowNode[] = [];
    let cur = evalEP(euclid), seg = 0;
    nodes.push({ kind: 'src', params: euclid, pattern: cur.slice(), flatIdx: null, segIdx: 0, isSegTerminal: false });
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.type === 'chain') {
        seg++;
        cur = evalEP(op.params);
        nodes.push({ kind: 'chain', params: op.params, pattern: cur.slice(), flatIdx: i, segIdx: seg, isSegTerminal: false });
      } else {
        cur = applyPatternOp(op, cur);
        nodes.push({ kind: op.type, params: op.type === 'invert' ? null : op.params, pattern: cur.slice(), flatIdx: i, segIdx: seg, isSegTerminal: false });
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      const next = nodes[i + 1];
      nodes[i].isSegTerminal = !next || next.kind === 'chain';
    }
    return nodes;
  }

  let _id = 0;
  const defEP = (): EP => ({ len: 16, steps: 4, div: 16, offset: 0 });
  const defLane = (): Lane => ({ id: _id++, euclid: defEP(), ops: [], sample: null, sampleName: 'CLK' });

  const saved = readSaved();
  if (saved?.lanes) {
    for (const sl of saved.lanes) if (sl.id >= _id) _id = sl.id + 1;
  }

  let bpm = $state(saved?.bpm ?? 120);
  let playing = $state(false);
  let lanes = $state<Lane[]>(saved?.lanes
    ? saved.lanes.map(sl => ({ id: sl.id, euclid: sl.euclid, ops: sl.ops, sample: null, sampleName: sl.sampleName }))
    : [defLane()]);
  let currentSteps = $state<Record<number, number>>({});
  let activeSegIdxs = $state<Record<number, number>>({});

  // Auto-save config whenever lanes or bpm change (browser only — $effect doesn't run during SSR)
  $effect(() => {
    if (typeof localStorage === 'undefined') return;
    const state: SavedState = {
      bpm,
      lanes: lanes.map(l => ({
        id: l.id, euclid: { ...l.euclid },
        ops: l.ops.map(op => ({ type: op.type, params: { ...op.params } })),
        sampleName: l.sampleName, hasSample: l.sample !== null
      }))
    };
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  });

  let audioCtx: AudioContext | null = null;
  let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  const rts = new Map<number, LaneRt>();

  function fireClick(ctx: AudioContext, at: number, accent: boolean) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'triangle'; o.frequency.value = accent ? 1400 : 800;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(accent ? 0.45 : 0.25, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
    o.start(at); o.stop(at + 0.05);
  }

  function playBuffer(ctx: AudioContext, buf: AudioBuffer, at: number) {
    const s = ctx.createBufferSource();
    s.buffer = buf; s.connect(ctx.destination); s.start(at);
  }

  function schedule() {
    if (!audioCtx || !playing) return;
    const lookahead = 0.12, now = audioCtx.currentTime;
    for (const lane of lanes) {
      let rt = rts.get(lane.id);
      if (!rt) { rt = { segIdx: 0, stepIdx: 0, nextStepTime: now }; rts.set(lane.id, rt); }
      while (rt.nextStepTime < now + lookahead) {
        const segs = evalPipeline(lane.euclid, lane.ops);
        const n = segs.length; if (!n) break;
        const si = rt.segIdx % n;
        const { pattern, div } = segs[si];
        if (!pattern.length) break;
        if (rt.stepIdx >= pattern.length) rt.stepIdx = 0;
        const isActive = pattern[rt.stepIdx] ?? false;
        if (isActive) {
          if (lane.sample) playBuffer(audioCtx!, lane.sample, rt.nextStepTime);
          else fireClick(audioCtx!, rt.nextStepTime, rt.stepIdx === 0);
        }
        const stepI = rt.stepIdx, lid = lane.id;
        const delay = Math.max(0, (rt.nextStepTime - now) * 1000 - 10);
        setTimeout(() => { currentSteps[lid] = stepI; }, delay);
        rt.nextStepTime += 60 / bpm / div;
        rt.stepIdx++;
        if (rt.stepIdx >= pattern.length) {
          rt.stepIdx = 0;
          const prev = si;
          rt.segIdx = (si + 1) % n;
          if (rt.segIdx !== prev) {
            const ns = rt.segIdx, lid2 = lane.id;
            setTimeout(() => { activeSegIdxs[lid2] = ns; }, delay);
          }
        }
      }
    }
    schedulerTimer = setTimeout(schedule, 20);
  }

  function start() {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime + 0.05;
    rts.clear();
    for (const lane of lanes) rts.set(lane.id, { segIdx: 0, stepIdx: 0, nextStepTime: t0 });
    currentSteps = {}; activeSegIdxs = {};
    playing = true; schedule();
  }

  function stop() {
    playing = false;
    if (schedulerTimer !== null) { clearTimeout(schedulerTimer); schedulerTimer = null; }
    currentSteps = {};
  }

  function togglePlay() { if (playing) stop(); else start(); }
  onDestroy(() => { if (schedulerTimer !== null) clearTimeout(schedulerTimer); audioCtx?.close(); });

  onMount(async () => {
    if (!saved?.lanes) return;
    for (const sl of saved.lanes) {
      if (!sl.hasSample) continue;
      try {
        const buf = await idbGet(sl.id);
        if (!buf) continue;
        if (!audioCtx) audioCtx = new AudioContext();
        const decoded = await audioCtx.decodeAudioData(buf);
        const lane = lanes.find(l => l.id === sl.id);
        if (lane) lane.sample = decoded;
      } catch (e) {
        console.warn('Failed to restore sample for lane', sl.id, e);
      }
    }
  });

  async function loadSample(lane: Lane, file: File) {
    if (!audioCtx) audioCtx = new AudioContext();
    const raw = await file.arrayBuffer();
    // Save a copy before decodeAudioData may detach the buffer
    idbPut(lane.id, raw.slice(0)).catch(e => console.warn('IDB save failed', e));
    lane.sample = await audioCtx.decodeAudioData(raw);
    lane.sampleName = file.name.replace(/\.[^.]+$/, '').slice(0, 8).toUpperCase();
  }

  type Drag = { y0: number; v0: number; moved: boolean } | null;
  let drag: Drag = null;
  function onNumDown(e: PointerEvent, getV: () => number) {
    drag = { y0: e.clientY, v0: getV(), moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onNumMove(e: PointerEvent, setV: (v: number) => void, lo: number, hi: number) {
    if (!drag || !(e.buttons & 1)) return;
    const dy = drag.y0 - e.clientY;
    if (!drag.moved && Math.abs(dy) > 3) { drag.moved = true; (e.currentTarget as HTMLElement).blur(); }
    if (drag.moved) setV(Math.max(lo, Math.min(hi, drag.v0 + Math.round(dy / 4))));
  }
  function onNumUp() { drag = null; }

  function addLane() { lanes = [...lanes, defLane()]; }
  function removeLane(id: number) {
    if (lanes.length > 1) {
      lanes = lanes.filter(l => l.id !== id);
      idbDelete(id).catch(() => {});
    }
  }

  function addOp(lane: Lane, type: OpType) {
    lane.ops = [...lane.ops, { type, params: defEP() }];
  }

  function removeOp(lane: Lane, flatIdx: number) {
    lane.ops = lane.ops.filter((_, i) => i !== flatIdx);
    const segs = evalPipeline(lane.euclid, lane.ops);
    const rt = rts.get(lane.id);
    if (rt && rt.segIdx >= segs.length) { rt.segIdx = 0; rt.stepIdx = 0; activeSegIdxs[lane.id] = 0; }
  }

  const OP_LABEL: Record<string, string> = { src: 'SRC', invert: 'INV', add: 'ADD', subtract: 'SUB', multiply: 'MUL', chain: 'CHAIN' };
</script>

{#snippet epInputs(p: EP)}
  <div class="param">
    <span class="param-label">L</span>
    <input type="number" value={p.len} min="1" max="64"
      onpointerdown={(e) => onNumDown(e, () => p.len)}
      onpointermove={(e) => onNumMove(e, (v) => { p.len = v; p.steps = Math.min(p.steps, v); }, 1, 64)}
      onpointerup={onNumUp}
      oninput={(e) => { if (!drag?.moved) { const v = Math.max(1, Math.min(64, +((e.currentTarget as HTMLInputElement).value) || 1)); p.len = v; p.steps = Math.min(p.steps, v); } }}
    />
  </div>
  <div class="param">
    <span class="param-label">S</span>
    <input type="number" value={p.steps} min="0" max={p.len}
      onpointerdown={(e) => onNumDown(e, () => p.steps)}
      onpointermove={(e) => onNumMove(e, (v) => { p.steps = v; }, 0, p.len)}
      onpointerup={onNumUp}
      oninput={(e) => { if (!drag?.moved) p.steps = Math.max(0, Math.min(p.len, +((e.currentTarget as HTMLInputElement).value))); }}
    />
  </div>
  <div class="param">
    <span class="param-label">D</span>
    <input type="number" value={p.div} min="1" max="32"
      onpointerdown={(e) => onNumDown(e, () => p.div)}
      onpointermove={(e) => onNumMove(e, (v) => { p.div = v; }, 1, 32)}
      onpointerup={onNumUp}
      oninput={(e) => { if (!drag?.moved) p.div = Math.max(1, Math.min(32, +((e.currentTarget as HTMLInputElement).value) || 1)); }}
    />
  </div>
  <div class="param">
    <span class="param-label">O</span>
    <input type="number" value={p.offset} min="0" max="63"
      onpointerdown={(e) => onNumDown(e, () => p.offset)}
      onpointermove={(e) => onNumMove(e, (v) => { p.offset = v; }, 0, 63)}
      onpointerup={onNumUp}
      oninput={(e) => { if (!drag?.moved) p.offset = Math.max(0, Math.min(63, +((e.currentTarget as HTMLInputElement).value))); }}
    />
  </div>
{/snippet}

<div class="euc-panel">
  <div class="top-bar">
    <span class="title">EUCLIDEAN</span>
    <div class="transport">
      <div class="param">
        <span class="param-label">BPM</span>
        <input type="number" value={bpm} min="20" max="300"
          onpointerdown={(e) => onNumDown(e, () => bpm)}
          onpointermove={(e) => onNumMove(e, (v) => { bpm = v; }, 20, 300)}
          onpointerup={onNumUp}
          oninput={(e) => { if (!drag?.moved) bpm = Math.max(20, Math.min(300, +((e.currentTarget as HTMLInputElement).value) || 120)); }}
        />
      </div>
      <button class="play-btn" class:is-playing={playing} onclick={togglePlay}>{playing ? '‖' : '▶'}</button>
      <button class="play-btn" onclick={() => location.reload()}>↺</button>
    </div>
  </div>

  <div class="lanes-body">
    {#each lanes as lane (lane.id)}
      {@const activeSeg = activeSegIdxs[lane.id] ?? 0}
      {@const nodes = getFlatNodes(lane.euclid, lane.ops)}
      <div class="lane">
        <div class="lane-hdr">
          <label class="sample-btn">
            {lane.sampleName}
            <input type="file" accept="audio/*" class="hidden-file"
              onchange={(e) => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; if (f) loadSample(lane, f); }} />
          </label>
          {#if lanes.length > 1}
            <button class="icon-btn" onclick={() => removeLane(lane.id)}>×</button>
          {/if}
        </div>

        <div class="flow-row">
          {#each nodes as node, ni}
            {#if ni > 0}
              <div class="flow-arrow">▸</div>
            {/if}
            <div class="flow-stage" class:node-active={activeSeg === node.segIdx}>
              <div class="pipeline-node">
                <div class="node-hdr">
                  <span class="node-badge badge-{node.kind}">{OP_LABEL[node.kind]}</span>
                  {#if node.flatIdx !== null}
                    <button class="icon-btn" onclick={() => removeOp(lane, node.flatIdx!)}>×</button>
                  {/if}
                </div>
                {#if node.params}
                  <div class="ep-col">{@render epInputs(node.params)}</div>
                {/if}
              </div>
              <div class="viz-col">
                <span class="viz-eq">=</span>
                <div class="euc-viz">
                  {#each node.pattern as active, si}
                    <div class="step" class:active class:downbeat={si === 0}
                      class:current={node.isSegTerminal && activeSeg === node.segIdx && currentSteps[lane.id] === si}
                    ></div>
                  {/each}
                </div>
              </div>
            </div>
          {/each}

          <div class="flow-arrow">▸</div>
          <div class="add-ops">
            {#each (['invert', 'add', 'subtract', 'multiply', 'chain'] as const) as ot}
              <button class="add-op-btn badge-{ot}" onclick={() => addOp(lane, ot)}>+{OP_LABEL[ot]}</button>
            {/each}
          </div>
        </div>
      </div>
    {/each}

    <button class="add-btn add-lane-btn" onclick={addLane}>+ LANE</button>
  </div>
</div>

<style>
  .euc-panel {
    font-family: var(--term-font, 'JetBrains Mono', 'Courier New', monospace);
    color: var(--panel-text, #e8e8e8);
    width: 100%;
    box-sizing: border-box;
  }

  .top-bar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 16px;
    background: var(--surface-raised, #262626);
    border-bottom: 1px solid #333;
  }

  .lanes-body { padding: 12px; }

  .title {
    font-size: 9px;
    letter-spacing: 0.12em;
    color: var(--panel-text-dim, #8a8a8a);
  }

  .transport { display: flex; align-items: center; gap: 8px; }

  .lane {
    background: var(--surface-raised, #262626);
    padding: 8px;
    margin-bottom: 8px;
  }

  .lane-hdr {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .sample-btn {
    font-size: 9px;
    letter-spacing: 0.08em;
    color: var(--panel-text-dim, #8a8a8a);
    background: var(--surface-bg, #1a1a1a);
    border: 1px solid #333;
    padding: 2px 6px;
    cursor: pointer;
    display: inline-block;
  }

  .sample-btn:hover { border-color: var(--panel-text-dim); color: var(--panel-text); }
  .hidden-file { display: none; }

  /* ── LTR signal-flow row ── */
  .flow-row {
    display: flex;
    align-items: flex-start;
    gap: 0;
    overflow-x: auto;
    padding-bottom: 4px;
  }

  .flow-arrow {
    flex-shrink: 0;
    align-self: flex-start;
    padding: 8px 4px 0;
    color: var(--panel-text-dim, #8a8a8a);
    font-size: 11px;
  }

  /* ── A stage = one processor block followed by its result viz ── */
  .flow-stage {
    flex-shrink: 0;
    display: flex;
    align-items: flex-start;
    border-top: 2px solid #333;
  }

  .flow-stage.node-active { border-top-color: var(--accent, #ff2050); }

  .pipeline-node {
    flex-shrink: 0;
    min-width: 72px;
    background: var(--surface-bg, #1a1a1a);
    padding: 5px 6px;
  }

  /* result viz shown after each processing block */
  .viz-col {
    flex-shrink: 0;
    display: flex;
    align-items: flex-start;
    gap: 4px;
    padding: 5px 6px;
    background: #141414;
  }

  .viz-eq {
    font-size: 11px;
    color: var(--panel-text-dim, #8a8a8a);
    line-height: 7px;
    padding-top: 1px;
  }

  .node-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 3px;
  }

  .node-badge {
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.08em;
    padding: 1px 4px;
    border: 1px solid currentColor;
    white-space: nowrap;
  }

  .badge-src    { color: var(--panel-text-dim, #8a8a8a); }
  .badge-chain  { color: #ffd740; }
  .badge-invert   { color: #b085f5; }
  .badge-add      { color: #69f0ae; }
  .badge-subtract { color: #ff7043; }
  .badge-multiply { color: #40c4ff; }

  /* params stacked vertically */
  .ep-col {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-bottom: 5px;
  }

  /* ── Viz (vertical column of step dots) ── */
  .euc-viz {
    display: flex;
    flex-direction: column;
    flex-wrap: nowrap;
    gap: 2px;
    min-height: 7px;
  }

  .step {
    width: 7px; height: 7px;
    background: #3a3a3a;
    flex-shrink: 0;
  }

  .step.active { background: #5a5a5a; }
  .step.downbeat { background: var(--panel-text, #e8e8e8); }
  .step.current { outline: 1px solid var(--accent, #ff2050); outline-offset: -1px; }
  .step.current.active, .step.current.downbeat { background: var(--accent, #ff2050); outline: none; }

  /* ── Add op buttons ── */
  .add-ops {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-top: 6px;
  }

  .add-op-btn {
    background: transparent;
    border: 1px solid currentColor;
    font-family: var(--term-font, 'JetBrains Mono', monospace);
    font-size: 9px;
    letter-spacing: 0.06em;
    cursor: pointer;
    padding: 2px 4px;
    opacity: 0.5;
    text-align: left;
  }

  .add-op-btn:hover { opacity: 1; }

  /* ── Shared param/input styles ── */
  .param {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 4px;
  }

  .param-label {
    font-size: 9px;
    color: var(--panel-text-dim, #8a8a8a);
    letter-spacing: 0.05em;
    user-select: none;
  }

  input[type='number'] {
    width: 44px;
    background: var(--surface-bg, #1a1a1a);
    border: 1px solid #333;
    color: var(--panel-text, #e8e8e8);
    font-family: var(--term-font, 'JetBrains Mono', 'Courier New', monospace);
    font-size: 11px;
    padding: 2px 3px;
    border-radius: 0;
    outline: none;
    cursor: ns-resize;
    appearance: textfield;
    -moz-appearance: textfield;
    box-sizing: border-box;
  }

  input[type='number']::-webkit-outer-spin-button,
  input[type='number']::-webkit-inner-spin-button { -webkit-appearance: none; }
  input[type='number']:focus { border-color: var(--panel-text-dim); cursor: text; }

  .play-btn {
    background: var(--surface-bg, #1a1a1a);
    border: 1px solid #333;
    color: var(--panel-text, #e8e8e8);
    font-family: var(--term-font, 'JetBrains Mono', 'Courier New', monospace);
    font-size: 14px;
    padding: 0 10px;
    cursor: pointer;
    border-radius: 0;
    height: 27px;
    line-height: 27px;
  }

  .play-btn:hover { border-color: var(--panel-text-dim); }
  .play-btn.is-playing { color: var(--accent, #ff2050); border-color: var(--accent, #ff2050); }

  .icon-btn {
    background: transparent;
    border: none;
    color: var(--panel-text-dim, #8a8a8a);
    font-size: 14px;
    cursor: pointer;
    padding: 0 1px;
    line-height: 1;
  }

  .icon-btn:hover { color: var(--panel-text); }

  .add-btn {
    background: transparent;
    border: 1px dashed #333;
    color: var(--panel-text-dim, #8a8a8a);
    font-family: var(--term-font, 'JetBrains Mono', monospace);
    font-size: 9px;
    letter-spacing: 0.08em;
    cursor: pointer;
    padding: 3px 8px;
    border-radius: 0;
    width: 100%;
    margin-top: 4px;
    display: block;
    box-sizing: border-box;
  }

  .add-btn:hover { border-color: var(--panel-text-dim); color: var(--panel-text); }
  .add-lane-btn { margin-top: 0; }
</style>
