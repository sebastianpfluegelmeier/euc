<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { type EP, evalEP } from './lib/euclid';
  import { type VoiceKind, playKick, playHat, playClap, playPerc, playClick, playSample } from './lib/voices';
  import {
    type Modulators, type ModSrc, type MParam, type LfoShape,
    mp, defModulators, resolveParam, MOD_SRCS, MOD_LABEL,
  } from './lib/mod';

  // ── IndexedDB helpers (raw sample bytes) ─────────────────────────────────────
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

  // ── Trigger pipeline (beat pattern generation) ───────────────────────────────
  type OpType = 'invert' | 'add' | 'subtract' | 'multiply' | 'chain';
  interface Op { type: OpType; params: EP; prevLen?: number; }

  interface FlowNode {
    kind: 'src' | OpType;
    params: EP | null;
    pattern: boolean[];
    flatIdx: number | null;
    isFinal: boolean;
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

  function applyChain(op: Op, pattern: boolean[], divs: number[]): { pattern: boolean[]; divs: number[] } {
    const np = evalEP(op.params);
    const x = Math.max(0, Math.min(op.prevLen ?? pattern.length, pattern.length));
    return {
      pattern: [...pattern.slice(0, x), ...np],
      divs: [...divs.slice(0, x), ...np.map(() => op.params.div)],
    };
  }

  function evalPipeline(euclid: EP, ops: Op[]): { pattern: boolean[]; divs: number[] } {
    let pattern = evalEP(euclid);
    let divs = pattern.map(() => euclid.div);
    for (const op of ops) {
      if (op.type === 'chain') ({ pattern, divs } = applyChain(op, pattern, divs));
      else pattern = applyPatternOp(op, pattern);
    }
    return { pattern, divs };
  }

  function getFlatNodes(euclid: EP, ops: Op[]): FlowNode[] {
    const nodes: FlowNode[] = [];
    let cur = evalEP(euclid);
    let divs = cur.map(() => euclid.div);
    nodes.push({ kind: 'src', params: euclid, pattern: cur.slice(), flatIdx: null, isFinal: false });
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.type === 'chain') {
        ({ pattern: cur, divs } = applyChain(op, cur, divs));
        nodes.push({ kind: 'chain', params: op.params, pattern: cur.slice(), flatIdx: i, isFinal: false });
      } else {
        cur = applyPatternOp(op, cur);
        nodes.push({ kind: op.type, params: op.type === 'invert' ? null : op.params, pattern: cur.slice(), flatIdx: i, isFinal: false });
      }
    }
    if (nodes.length) nodes[nodes.length - 1].isFinal = true;
    return nodes;
  }

  // ── Track model ──────────────────────────────────────────────────────────────
  interface Lane {
    id: number;
    euclid: EP; ops: Op[];                 // trigger pattern
    source: VoiceKind;
    sample: AudioBuffer | null; sampleName: string;
    tune: MParam; decay: MParam; punch: MParam; tone: MParam;  // voice params
    cutoff: MParam; amp: MParam;           // track filter + level
    accent: EP; accentAmt: number;         // accent pattern + boost (%)
  }
  interface LaneRt { stepIdx: number; absStep: number; nextStepTime: number; }

  let _id = 0;
  const defEP = (): EP => ({ len: 16, steps: 4, div: 16, offset: 0 });
  function defLane(source: VoiceKind = 'kick'): Lane {
    return {
      id: _id++, euclid: defEP(), ops: [], source,
      sample: null, sampleName: 'SAMPLE',
      tune: mp(55, 30, 800), decay: mp(350, 20, 1500), punch: mp(50, 0, 100), tone: mp(7000, 500, 14000),
      cutoff: mp(18000, 100, 18000), amp: mp(80, 0, 100),
      accent: { len: 16, steps: 0, div: 16, offset: 0 }, accentAmt: 160,
    };
  }

  // ── Persistence (localStorage config + IndexedDB samples) ─────────────────────
  const LS_KEY = 'euc-state-v2';
  const SAVE_VERSION = 2;
  interface SavedLane {
    id: number; euclid: EP; ops: Op[]; source: VoiceKind; sampleName: string; hasSample: boolean;
    tune: MParam; decay: MParam; punch: MParam; tone: MParam; cutoff: MParam; amp: MParam;
    accent: EP; accentAmt: number;
  }
  interface SavedState { version: number; bpm: number; lanes: SavedLane[]; mods: Modulators; }

  function readSaved(): SavedState | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null');
      return s && s.version === SAVE_VERSION ? s : null;
    } catch { return null; }
  }
  function restoreLane(sl: SavedLane): Lane {
    return {
      id: sl.id, euclid: sl.euclid, ops: sl.ops, source: sl.source,
      sample: null, sampleName: sl.sampleName,
      tune: sl.tune, decay: sl.decay, punch: sl.punch, tone: sl.tone,
      cutoff: sl.cutoff, amp: sl.amp, accent: sl.accent, accentAmt: sl.accentAmt,
    };
  }

  const saved = readSaved();
  if (saved) for (const sl of saved.lanes) if (sl.id >= _id) _id = sl.id + 1;

  let bpm = $state(saved?.bpm ?? 120);
  let playing = $state(false);
  let lanes = $state<Lane[]>(saved ? saved.lanes.map(restoreLane) : [defLane('kick')]);
  let mods = $state<Modulators>(saved?.mods ?? defModulators());
  let currentSteps = $state<Record<number, number>>({});

  $effect(() => {
    if (typeof localStorage === 'undefined') return;
    const state: SavedState = {
      version: SAVE_VERSION, bpm, mods,
      lanes: lanes.map(l => ({
        id: l.id, euclid: { ...l.euclid },
        ops: l.ops.map(op => ({ type: op.type, params: { ...op.params }, prevLen: op.prevLen })),
        source: l.source, sampleName: l.sampleName, hasSample: l.sample !== null,
        tune: l.tune, decay: l.decay, punch: l.punch, tone: l.tone, cutoff: l.cutoff, amp: l.amp,
        accent: { ...l.accent }, accentAmt: l.accentAmt,
      })),
    };
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  });

  // ── Audio engine ─────────────────────────────────────────────────────────────
  let audioCtx: AudioContext | null = null;
  let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  let transportT0 = 0;
  const rts = new Map<number, LaneRt>();

  function triggerHit(lane: Lane, at: number, absStep: number, downbeat: boolean) {
    const ctx = audioCtx!;
    const mc = { bpm, t0: transportT0 };
    const cutoff = resolveParam(lane.cutoff, mods, at, mc);
    const amp = resolveParam(lane.amp, mods, at, mc) / 100;
    const accPat = evalEP(lane.accent);
    const accOn = accPat.length ? (accPat[absStep % accPat.length] ?? false) : false;
    const gainVal = amp * (accOn ? lane.accentAmt / 100 : 1);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = cutoff; filter.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.value = gainVal;
    filter.connect(g); g.connect(ctx.destination);

    const tune = () => resolveParam(lane.tune, mods, at, mc);
    const decay = () => resolveParam(lane.decay, mods, at, mc) / 1000;
    const tone = () => resolveParam(lane.tone, mods, at, mc);
    switch (lane.source) {
      case 'kick': playKick(ctx, filter, at, { tune: tune(), decay: decay(), punch: resolveParam(lane.punch, mods, at, mc) / 100 }); break;
      case 'hat': playHat(ctx, filter, at, { decay: decay(), tone: tone() }); break;
      case 'clap': playClap(ctx, filter, at, { decay: decay(), tone: tone() }); break;
      case 'perc': playPerc(ctx, filter, at, { tune: tune(), decay: decay() }); break;
      case 'sample':
        if (lane.sample) playSample(ctx, filter, lane.sample, at);
        else playClick(ctx, filter, at, downbeat);
        break;
    }
  }

  function schedule() {
    if (!audioCtx || !playing) return;
    const lookahead = 0.12, now = audioCtx.currentTime;
    for (const lane of lanes) {
      let rt = rts.get(lane.id);
      if (!rt) { rt = { stepIdx: 0, absStep: 0, nextStepTime: now }; rts.set(lane.id, rt); }
      while (rt.nextStepTime < now + lookahead) {
        const { pattern, divs } = evalPipeline(lane.euclid, lane.ops);
        if (!pattern.length) break;
        if (rt.stepIdx >= pattern.length) rt.stepIdx = 0;
        if (pattern[rt.stepIdx]) triggerHit(lane, rt.nextStepTime, rt.absStep, rt.stepIdx === 0);
        const stepI = rt.stepIdx, lid = lane.id;
        const delay = Math.max(0, (rt.nextStepTime - now) * 1000 - 10);
        setTimeout(() => { currentSteps[lid] = stepI; }, delay);
        const div = divs[rt.stepIdx] || 16;
        rt.nextStepTime += 60 / bpm / div;
        rt.stepIdx = (rt.stepIdx + 1) % pattern.length;
        rt.absStep++;
      }
    }
    schedulerTimer = setTimeout(schedule, 20);
  }

  function start() {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime + 0.05;
    transportT0 = t0;
    rts.clear();
    for (const lane of lanes) rts.set(lane.id, { stepIdx: 0, absStep: 0, nextStepTime: t0 });
    currentSteps = {};
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
    if (!saved) return;
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
    idbPut(lane.id, raw.slice(0)).catch(e => console.warn('IDB save failed', e));
    lane.sample = await audioCtx.decodeAudioData(raw);
    lane.sampleName = file.name.replace(/\.[^.]+$/, '').slice(0, 8).toUpperCase();
  }

  // ── Drag-to-change number inputs ─────────────────────────────────────────────
  type Drag = { y0: number; v0: number; moved: boolean } | null;
  let drag: Drag = null;
  function onNumDown(e: PointerEvent, getV: () => number) {
    drag = { y0: e.clientY, v0: getV(), moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onNumMove(e: PointerEvent, setV: (v: number) => void, lo: number, hi: number, step = 1) {
    if (!drag || !(e.buttons & 1)) return;
    const dy = drag.y0 - e.clientY;
    if (!drag.moved && Math.abs(dy) > 3) { drag.moved = true; (e.currentTarget as HTMLElement).blur(); }
    if (drag.moved) setV(Math.max(lo, Math.min(hi, drag.v0 + Math.round(dy / 4) * step)));
  }
  function onNumUp() { drag = null; }

  // ── Mutations ────────────────────────────────────────────────────────────────
  const SRC_CYCLE: VoiceKind[] = ['kick', 'hat', 'clap', 'perc'];
  function addLane() { lanes = [...lanes, defLane(SRC_CYCLE[lanes.length % SRC_CYCLE.length])]; }
  function removeLane(id: number) {
    if (lanes.length > 1) { lanes = lanes.filter(l => l.id !== id); idbDelete(id).catch(() => {}); }
  }
  function addOp(lane: Lane, type: OpType) {
    const op: Op = { type, params: defEP() };
    if (type === 'chain') op.prevLen = 16;
    lane.ops = [...lane.ops, op];
  }
  function removeOp(lane: Lane, flatIdx: number) { lane.ops = lane.ops.filter((_, i) => i !== flatIdx); }
  function toggleMod(p: MParam, src: ModSrc) {
    const i = p.mods.findIndex(m => m.src === src);
    if (i >= 0) p.mods = p.mods.filter((_, j) => j !== i);
    else p.mods = [...p.mods, { src, depth: 50 }];
  }

  // ── UI constants ─────────────────────────────────────────────────────────────
  const OP_LABEL: Record<string, string> = { src: 'SRC', invert: 'INV', add: 'ADD', subtract: 'SUB', multiply: 'MUL', chain: 'CHAIN' };
  const SOURCES: { v: VoiceKind; label: string }[] = [
    { v: 'kick', label: 'KICK' }, { v: 'hat', label: 'HAT' }, { v: 'clap', label: 'CLAP' },
    { v: 'perc', label: 'PERC' }, { v: 'sample', label: 'SMPL' },
  ];
  const LFO_SHAPES: LfoShape[] = ['sine', 'tri', 'saw', 'square'];
  const LFO_RATES: { v: number; label: string }[] = [
    { v: 0.25, label: '4 bars' }, { v: 0.5, label: '2 bars' }, { v: 1, label: '1 bar' },
    { v: 2, label: '1/2' }, { v: 4, label: '1/4' }, { v: 8, label: '1/8' }, { v: 16, label: '1/16' },
  ];
</script>

<!-- Generic labeled draggable number -->
{#snippet num(label: string, get: () => number, set: (v: number) => void, lo: number, hi: number, step: number)}
  <div class="param">
    <span class="param-label">{label}</span>
    <input type="number" value={get()} min={lo} max={hi}
      onpointerdown={(e) => onNumDown(e, get)}
      onpointermove={(e) => onNumMove(e, set, lo, hi, step)}
      onpointerup={onNumUp}
      oninput={(e) => { if (!drag?.moved) set(Math.max(lo, Math.min(hi, Math.round(+((e.currentTarget as HTMLInputElement).value) || lo)))); }}
    />
  </div>
{/snippet}

<!-- Euclidean params L/S/D/O -->
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

{#snippet prevLenInput(op: Op)}
  <div class="param">
    <span class="param-label" title="prev length">P</span>
    <input type="number" value={op.prevLen ?? 16} min="0" max="64"
      onpointerdown={(e) => onNumDown(e, () => op.prevLen ?? 16)}
      onpointermove={(e) => onNumMove(e, (v) => { op.prevLen = v; }, 0, 64)}
      onpointerup={onNumUp}
      oninput={(e) => { if (!drag?.moved) op.prevLen = Math.max(0, Math.min(64, +((e.currentTarget as HTMLInputElement).value))); }}
    />
  </div>
{/snippet}

<!-- Modulatable param: value + mod-source toggles + per-source depth -->
{#snippet mparam(label: string, p: MParam, step: number)}
  <div class="mparam">
    {@render num(label, () => p.value, (v) => p.value = v, p.min, p.max, step)}
    <div class="mod-row">
      {#each MOD_SRCS as src}
        <button class="mod-btn b-{src}" class:on={p.mods.some(m => m.src === src)}
          onclick={() => toggleMod(p, src)}>{MOD_LABEL[src]}</button>
      {/each}
    </div>
    {#each p.mods as ref (ref.src)}
      <div class="depth b-{ref.src}">
        {@render num(MOD_LABEL[ref.src], () => ref.depth, (v) => ref.depth = v, -100, 100, 5)}
      </div>
    {/each}
  </div>
{/snippet}

<div class="euc-panel">
  <div class="top-bar">
    <span class="title">EUCLIDEAN</span>
    <div class="transport">
      {@render num('BPM', () => bpm, (v) => bpm = v, 20, 300, 1)}
      <button class="play-btn" class:is-playing={playing} onclick={togglePlay}>{playing ? '‖' : '▶'}</button>
      <button class="play-btn" onclick={() => location.reload()}>↺</button>
    </div>
  </div>

  <!-- Global modulators -->
  <div class="mod-panel">
    <span class="title">MODULATORS</span>
    <div class="mod-grid">
      {#each ([['lfo1', mods.lfo1], ['lfo2', mods.lfo2]] as const) as [key, lfo]}
        <div class="mod-card">
          <span class="mod-name b-{key}">{MOD_LABEL[key]}</span>
          <select class="mini-select" value={lfo.rate}
            onchange={(e) => lfo.rate = +(e.currentTarget as HTMLSelectElement).value}>
            {#each LFO_RATES as r}<option value={r.v}>{r.label}</option>{/each}
          </select>
          <select class="mini-select" value={lfo.shape}
            onchange={(e) => lfo.shape = (e.currentTarget as HTMLSelectElement).value as LfoShape}>
            {#each LFO_SHAPES as s}<option value={s}>{s}</option>{/each}
          </select>
          <button class="uni-btn" class:on={lfo.unipolar} title="unipolar (0..1)"
            onclick={() => lfo.unipolar = !lfo.unipolar}>UNI</button>
        </div>
      {/each}
      {#each ([['env1', mods.env1], ['env2', mods.env2]] as const) as [key, env]}
        <div class="mod-card">
          <span class="mod-name b-{key}">{MOD_LABEL[key]}</span>
          <div class="ep-row">{@render epInputs(env.euclid)}</div>
          <div class="ep-row">
            {@render num('ATK', () => env.attack, (v) => env.attack = v, 1, 1000, 5)}
            {@render num('DEC', () => env.decay, (v) => env.decay = v, 10, 3000, 10)}
          </div>
        </div>
      {/each}
    </div>
  </div>

  <div class="lanes-body">
    {#each lanes as lane (lane.id)}
      {@const nodes = getFlatNodes(lane.euclid, lane.ops)}
      <div class="lane">
        <div class="lane-hdr">
          <select class="src-select" value={lane.source}
            onchange={(e) => lane.source = (e.currentTarget as HTMLSelectElement).value as VoiceKind}>
            {#each SOURCES as s}<option value={s.v}>{s.label}</option>{/each}
          </select>
          {#if lane.source === 'sample'}
            <label class="sample-btn">
              {lane.sampleName}
              <input type="file" accept="audio/*" class="hidden-file"
                onchange={(e) => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; if (f) loadSample(lane, f); }} />
            </label>
          {/if}
          <span class="spacer"></span>
          {#if lanes.length > 1}
            <button class="icon-btn" onclick={() => removeLane(lane.id)}>×</button>
          {/if}
        </div>

        <!-- Trigger pattern pipeline -->
        <div class="flow-row">
          {#each nodes as node, ni}
            {#if ni > 0}<div class="flow-arrow">▸</div>{/if}
            <div class="flow-stage" class:node-active={node.isFinal && playing}>
              <div class="pipeline-node">
                <div class="node-hdr">
                  <span class="node-badge badge-{node.kind}">{OP_LABEL[node.kind]}</span>
                  {#if node.flatIdx !== null}
                    <button class="icon-btn" onclick={() => removeOp(lane, node.flatIdx!)}>×</button>
                  {/if}
                </div>
                {#if node.params}
                  <div class="ep-col">
                    {#if node.kind === 'chain' && node.flatIdx !== null}
                      {@render prevLenInput(lane.ops[node.flatIdx])}
                    {/if}
                    {@render epInputs(node.params)}
                  </div>
                {/if}
              </div>
              <div class="viz-col">
                <span class="viz-eq">=</span>
                <div class="euc-viz">
                  {#each node.pattern as active, si}
                    <div class="step" class:active class:downbeat={si === 0}
                      class:current={node.isFinal && currentSteps[lane.id] === si}></div>
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

        <!-- Sound: voice + filter + level + accent -->
        <div class="sound-row">
          {#if lane.source === 'kick'}
            {@render mparam('TUNE', lane.tune, 1)}
            {@render mparam('DECAY', lane.decay, 10)}
            {@render mparam('PUNCH', lane.punch, 2)}
          {:else if lane.source === 'hat' || lane.source === 'clap'}
            {@render mparam('DECAY', lane.decay, 10)}
            {@render mparam('TONE', lane.tone, 100)}
          {:else if lane.source === 'perc'}
            {@render mparam('TUNE', lane.tune, 1)}
            {@render mparam('DECAY', lane.decay, 10)}
          {/if}
          {@render mparam('CUTOFF', lane.cutoff, 100)}
          {@render mparam('LEVEL', lane.amp, 2)}
          <div class="accent">
            <span class="param-label acc-lbl">ACCENT</span>
            <div class="ep-row">{@render epInputs(lane.accent)}</div>
            {@render num('AMT', () => lane.accentAmt, (v) => lane.accentAmt = v, 100, 400, 5)}
          </div>
        </div>
      </div>
    {/each}

    <button class="add-btn add-lane-btn" onclick={addLane}>+ TRACK</button>
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
    position: sticky; top: 0; z-index: 10;
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 16px;
    background: var(--surface-raised, #262626);
    border-bottom: 1px solid #333;
  }

  .title { font-size: 9px; letter-spacing: 0.12em; color: var(--panel-text-dim, #8a8a8a); }
  .transport { display: flex; align-items: center; gap: 8px; }

  /* ── Modulators panel ── */
  .mod-panel {
    padding: 8px 12px;
    background: #1d1d1d;
    border-bottom: 1px solid #333;
    display: flex; flex-direction: column; gap: 6px;
  }
  .mod-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .mod-card {
    display: flex; align-items: center; gap: 6px;
    background: var(--surface-bg, #1a1a1a);
    border: 1px solid #2e2e2e;
    padding: 5px 7px;
  }
  .mod-name {
    font-size: 10px; font-weight: 500; letter-spacing: 0.06em;
    border: 1px solid currentColor; padding: 1px 4px;
  }
  .ep-row { display: flex; gap: 6px; align-items: center; }

  .mini-select, .src-select {
    background: var(--surface-bg, #1a1a1a);
    border: 1px solid #333;
    color: var(--panel-text, #e8e8e8);
    font-family: var(--term-font, monospace);
    font-size: 10px; padding: 2px 3px; border-radius: 0; outline: none; cursor: pointer;
  }
  .mini-select:focus, .src-select:focus { border-color: var(--panel-text-dim); }

  .uni-btn {
    background: transparent; border: 1px solid #444; color: var(--panel-text-dim, #8a8a8a);
    font-family: var(--term-font, monospace); font-size: 9px; padding: 2px 5px; cursor: pointer; opacity: 0.7;
  }
  .uni-btn.on { color: var(--accent, #ff2050); border-color: var(--accent, #ff2050); opacity: 1; }

  .lanes-body { padding: 12px; }

  .lane { background: var(--surface-raised, #262626); padding: 8px; margin-bottom: 8px; }
  .lane-hdr { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .spacer { flex: 1; }

  .sample-btn {
    font-size: 9px; letter-spacing: 0.08em; color: var(--panel-text-dim, #8a8a8a);
    background: var(--surface-bg, #1a1a1a); border: 1px solid #333; padding: 3px 6px; cursor: pointer;
  }
  .sample-btn:hover { border-color: var(--panel-text-dim); color: var(--panel-text); }
  .hidden-file { display: none; }

  /* ── Trigger pipeline (LTR flow) ── */
  .flow-row { display: flex; align-items: flex-start; gap: 0; overflow-x: auto; padding-bottom: 4px; }
  .flow-arrow { flex-shrink: 0; align-self: flex-start; padding: 8px 4px 0; color: var(--panel-text-dim, #8a8a8a); font-size: 11px; }

  .flow-stage { flex-shrink: 0; display: flex; align-items: stretch; height: 152px; border-top: 2px solid #333; }
  .flow-stage.node-active { border-top-color: var(--accent, #ff2050); }

  .pipeline-node { flex-shrink: 0; min-width: 72px; background: var(--surface-bg, #1a1a1a); padding: 5px 6px; }
  .viz-col { flex-shrink: 0; display: flex; align-items: flex-start; gap: 4px; padding: 5px 6px; background: #141414; }
  .viz-eq { font-size: 11px; color: var(--panel-text-dim, #8a8a8a); line-height: 7px; padding-top: 1px; }

  .node-hdr { display: flex; align-items: center; justify-content: space-between; margin-bottom: 3px; }
  .node-badge { font-size: 9px; font-weight: 500; letter-spacing: 0.08em; padding: 1px 4px; border: 1px solid currentColor; white-space: nowrap; }

  .badge-src { color: var(--panel-text-dim, #8a8a8a); }
  .badge-chain { color: #ffd740; }
  .badge-invert { color: #b085f5; }
  .badge-add { color: #69f0ae; }
  .badge-subtract { color: #ff7043; }
  .badge-multiply { color: #40c4ff; }

  .ep-col { display: flex; flex-direction: column; gap: 3px; margin-bottom: 5px; }

  .euc-viz { display: grid; grid-auto-flow: column; grid-template-rows: repeat(16, 7px); grid-auto-columns: 7px; gap: 2px; }
  .step { width: 7px; height: 7px; background: #3a3a3a; }
  .step.active { background: #5a5a5a; }
  .step.downbeat { background: var(--panel-text, #e8e8e8); }
  .step.current { outline: 1px solid var(--accent, #ff2050); outline-offset: -1px; }
  .step.current.active, .step.current.downbeat { background: var(--accent, #ff2050); outline: none; }

  .add-ops { flex-shrink: 0; display: flex; flex-direction: column; gap: 3px; padding-top: 6px; }
  .add-op-btn {
    background: transparent; border: 1px solid currentColor;
    font-family: var(--term-font, monospace); font-size: 9px; letter-spacing: 0.06em;
    cursor: pointer; padding: 2px 4px; opacity: 0.5; text-align: left;
  }
  .add-op-btn:hover { opacity: 1; }

  /* ── Sound row ── */
  .sound-row {
    display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px;
    margin-top: 8px; padding-top: 8px; border-top: 1px solid #333;
  }
  .mparam { display: flex; flex-direction: column; gap: 3px; }
  .mod-row { display: flex; gap: 2px; }
  .mod-btn {
    background: transparent; border: 1px solid currentColor; color: var(--panel-text-dim, #8a8a8a);
    font-family: var(--term-font, monospace); font-size: 8px; padding: 1px 3px; cursor: pointer; opacity: 0.4;
  }
  .mod-btn.on { opacity: 1; }
  .depth { opacity: 0.95; }

  .accent { display: flex; align-items: center; gap: 6px; }
  .acc-lbl { color: var(--accent, #ff2050); }

  /* mod source colors */
  .b-lfo1 { color: #40c4ff; }
  .b-lfo2 { color: #18ffd5; }
  .b-env1 { color: #ffd740; }
  .b-env2 { color: #ff7043; }

  /* ── Shared param/input styles ── */
  .param { display: flex; flex-direction: row; align-items: center; gap: 4px; }
  .param-label { font-size: 9px; color: var(--panel-text-dim, #8a8a8a); letter-spacing: 0.05em; user-select: none; }

  input[type='number'] {
    width: 44px; background: var(--surface-bg, #1a1a1a); border: 1px solid #333; color: var(--panel-text, #e8e8e8);
    font-family: var(--term-font, monospace); font-size: 11px; padding: 2px 3px; border-radius: 0; outline: none;
    cursor: ns-resize; appearance: textfield; -moz-appearance: textfield; box-sizing: border-box;
  }
  input[type='number']::-webkit-outer-spin-button,
  input[type='number']::-webkit-inner-spin-button { -webkit-appearance: none; }
  input[type='number']:focus { border-color: var(--panel-text-dim); cursor: text; }

  .play-btn {
    background: var(--surface-bg, #1a1a1a); border: 1px solid #333; color: var(--panel-text, #e8e8e8);
    font-family: var(--term-font, monospace); font-size: 14px; padding: 0 10px; cursor: pointer;
    border-radius: 0; height: 27px; line-height: 27px;
  }
  .play-btn:hover { border-color: var(--panel-text-dim); }
  .play-btn.is-playing { color: var(--accent, #ff2050); border-color: var(--accent, #ff2050); }

  .icon-btn { background: transparent; border: none; color: var(--panel-text-dim, #8a8a8a); font-size: 14px; cursor: pointer; padding: 0 1px; line-height: 1; }
  .icon-btn:hover { color: var(--panel-text); }

  .add-btn {
    background: transparent; border: 1px dashed #333; color: var(--panel-text-dim, #8a8a8a);
    font-family: var(--term-font, monospace); font-size: 9px; letter-spacing: 0.08em; cursor: pointer;
    padding: 3px 8px; border-radius: 0; width: 100%; margin-top: 4px; display: block; box-sizing: border-box;
  }
  .add-btn:hover { border-color: var(--panel-text-dim); color: var(--panel-text); }
  .add-lane-btn { margin-top: 0; }
</style>
