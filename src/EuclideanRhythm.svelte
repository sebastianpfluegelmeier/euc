<script lang="ts">
  import { onDestroy } from 'svelte';

  interface EP { len: number; steps: number; div: number; offset: number; }
  type OpType = 'invert' | 'add' | 'subtract' | 'multiply';
  interface Op { type: OpType; params: EP; }
  interface Segment { euclid: EP; ops: Op[]; reps: number; }
  interface Lane { id: number; segments: Segment[]; sample: AudioBuffer | null; sampleName: string; }
  interface LaneRt { segIdx: number; repsDone: number; stepIdx: number; nextStepTime: number; }

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

  function applyOp(op: Op, cur: boolean[]): boolean[] {
    if (op.type === 'invert') return cur.map(b => !b);
    const b = evalEP(op.params);
    return cur.map((a, i) => {
      const bi = b[i % b.length] ?? false;
      if (op.type === 'add') return a || bi;
      if (op.type === 'subtract') return a && !bi;
      return a && bi;
    });
  }

  function evalSegment(seg: Segment): boolean[] {
    let p = evalEP(seg.euclid);
    for (const op of seg.ops) p = applyOp(op, p);
    return p;
  }

  function getIntermediates(seg: Segment): boolean[][] {
    const out: boolean[][] = [];
    let p = evalEP(seg.euclid);
    out.push(p.slice());
    for (const op of seg.ops) { p = applyOp(op, p); out.push(p.slice()); }
    return out;
  }

  let _id = 0;
  const defEP = (): EP => ({ len: 16, steps: 4, div: 4, offset: 0 });
  const defSeg = (): Segment => ({ euclid: defEP(), ops: [], reps: 1 });
  const defLane = (): Lane => ({ id: _id++, segments: [defSeg()], sample: null, sampleName: 'CLK' });

  let bpm = $state(120);
  let playing = $state(false);
  let lanes = $state<Lane[]>([defLane()]);
  let currentSteps = $state<Record<number, number>>({});
  let activeSegIdxs = $state<Record<number, number>>({});

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
      if (!rt) { rt = { segIdx: 0, repsDone: 0, stepIdx: 0, nextStepTime: now }; rts.set(lane.id, rt); }
      while (rt.nextStepTime < now + lookahead) {
        const si = Math.min(rt.segIdx, lane.segments.length - 1);
        const seg = lane.segments[si];
        if (!seg) break;
        const pat = evalSegment(seg);
        if (rt.stepIdx >= pat.length) rt.stepIdx = 0;
        const isActive = pat[rt.stepIdx] ?? false;
        if (isActive) {
          if (lane.sample) playBuffer(audioCtx!, lane.sample, rt.nextStepTime);
          else fireClick(audioCtx!, rt.nextStepTime, rt.stepIdx === 0);
        }
        const stepI = rt.stepIdx, lid = lane.id;
        const delay = Math.max(0, (rt.nextStepTime - now) * 1000 - 10);
        setTimeout(() => { currentSteps[lid] = stepI; }, delay);
        rt.nextStepTime += 60 / bpm / seg.euclid.div;
        rt.stepIdx++;
        if (rt.stepIdx >= pat.length) {
          rt.stepIdx = 0;
          rt.repsDone++;
          if (rt.repsDone >= seg.reps) {
            rt.repsDone = 0;
            const prev = rt.segIdx;
            rt.segIdx = (rt.segIdx + 1) % Math.max(1, lane.segments.length);
            if (rt.segIdx !== prev) {
              const ns = rt.segIdx, lid2 = lane.id;
              setTimeout(() => { activeSegIdxs[lid2] = ns; }, delay);
            }
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
    for (const lane of lanes) rts.set(lane.id, { segIdx: 0, repsDone: 0, stepIdx: 0, nextStepTime: t0 });
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

  async function loadSample(lane: Lane, file: File) {
    if (!audioCtx) audioCtx = new AudioContext();
    const raw = await file.arrayBuffer();
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
  function removeLane(id: number) { if (lanes.length > 1) lanes = lanes.filter(l => l.id !== id); }
  function addSegment(lane: Lane) {
    const last = lane.segments[lane.segments.length - 1];
    lane.segments = [...lane.segments, { euclid: { ...last.euclid }, ops: [], reps: 1 }];
  }
  function removeSegment(lane: Lane, i: number) {
    if (lane.segments.length <= 1) return;
    lane.segments = lane.segments.filter((_, j) => j !== i);
    const rt = rts.get(lane.id);
    if (rt && rt.segIdx >= lane.segments.length) {
      rt.segIdx = 0; rt.repsDone = 0; rt.stepIdx = 0;
      activeSegIdxs[lane.id] = 0;
    }
  }
  function addOp(seg: Segment, type: OpType) {
    seg.ops = [...seg.ops, { type, params: defEP() }];
  }
  function removeOp(seg: Segment, i: number) {
    seg.ops = seg.ops.filter((_, j) => j !== i);
  }

  const OP_LABEL: Record<string, string> = { invert: 'INV', add: 'ADD', subtract: 'SUB', multiply: 'MUL' };
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

        {#each lane.segments as seg, segI}
          {@const ims = getIntermediates(seg)}
          {@const isCurrent = activeSeg === segI}
          <div class="segment" class:seg-active={isCurrent}>

            <!-- SOURCE node -->
            <div class="pipeline-node">
              <div class="node-row">
                <span class="node-badge badge-src">SRC</span>
                <div class="ep-row">{@render epInputs(seg.euclid)}</div>
                <div class="param">
                  <span class="param-label">R</span>
                  <input type="number" value={seg.reps} min="1" max="64"
                    onpointerdown={(e) => onNumDown(e, () => seg.reps)}
                    onpointermove={(e) => onNumMove(e, (v) => { seg.reps = v; }, 1, 64)}
                    onpointerup={onNumUp}
                    oninput={(e) => { if (!drag?.moved) seg.reps = Math.max(1, Math.min(64, +((e.currentTarget as HTMLInputElement).value) || 1)); }}
                  />
                </div>
                {#if lane.segments.length > 1}
                  <button class="icon-btn" onclick={() => removeSegment(lane, segI)}>×</button>
                {/if}
              </div>
              <div class="euc-viz">
                {#each ims[0] as active, si}
                  <div class="step" class:active class:downbeat={si === 0}
                    class:current={isCurrent && seg.ops.length === 0 && currentSteps[lane.id] === si}
                  ></div>
                {/each}
              </div>
            </div>

            <!-- OP nodes -->
            {#each seg.ops as op, opI}
              <div class="pipe-arrow">▾</div>
              <div class="pipeline-node">
                <div class="node-row">
                  <span class="node-badge badge-{op.type}">{OP_LABEL[op.type]}</span>
                  {#if op.type !== 'invert'}
                    <div class="ep-row">{@render epInputs(op.params)}</div>
                  {/if}
                  <button class="icon-btn" onclick={() => removeOp(seg, opI)}>×</button>
                </div>
                <div class="euc-viz">
                  {#each ims[opI + 1] as active, si}
                    <div class="step" class:active class:downbeat={si === 0}
                      class:current={isCurrent && opI === seg.ops.length - 1 && currentSteps[lane.id] === si}
                    ></div>
                  {/each}
                </div>
              </div>
            {/each}

            <!-- Add op buttons -->
            <div class="add-ops">
              {#each (['invert', 'add', 'subtract', 'multiply'] as const) as ot}
                <button class="add-op-btn badge-{ot}" onclick={() => addOp(seg, ot)}>+{OP_LABEL[ot]}</button>
              {/each}
            </div>
          </div>

          {#if segI < lane.segments.length - 1}
            <div class="chain-connector">▾ CHAIN</div>
          {/if}
        {/each}

        <button class="add-btn" onclick={() => addSegment(lane)}>+ CHAIN</button>
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

  .segment {
    border-left: 2px solid #333;
    padding-left: 6px;
    margin-bottom: 4px;
  }

  .segment.seg-active { border-left-color: var(--accent, #ff2050); }

  .pipeline-node {
    background: var(--surface-bg, #1a1a1a);
    padding: 6px;
    margin-bottom: 2px;
  }

  .node-row {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    margin-bottom: 5px;
    flex-wrap: wrap;
  }

  .ep-row {
    display: flex;
    gap: 4px;
    align-items: flex-end;
    flex-wrap: wrap;
  }

  .node-badge {
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.08em;
    padding: 2px 5px;
    border: 1px solid currentColor;
    white-space: nowrap;
    align-self: flex-end;
    margin-bottom: 1px;
  }

  .badge-src      { color: var(--panel-text-dim, #8a8a8a); }
  .badge-invert   { color: #b085f5; }
  .badge-add      { color: #69f0ae; }
  .badge-subtract { color: #ff7043; }
  .badge-multiply { color: #40c4ff; }

  .pipe-arrow {
    font-size: 10px;
    color: var(--panel-text-dim, #8a8a8a);
    padding-left: 8px;
    margin: 1px 0;
  }

  .euc-viz {
    display: flex;
    flex-wrap: wrap;
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

  .add-ops {
    display: flex;
    gap: 4px;
    margin-top: 5px;
    flex-wrap: wrap;
  }

  .add-op-btn {
    background: transparent;
    border: 1px solid currentColor;
    font-family: var(--term-font, 'JetBrains Mono', monospace);
    font-size: 9px;
    letter-spacing: 0.06em;
    cursor: pointer;
    padding: 2px 6px;
    opacity: 0.55;
  }

  .add-op-btn:hover { opacity: 1; }

  .chain-connector {
    font-size: 9px;
    letter-spacing: 0.1em;
    color: var(--panel-text-dim, #8a8a8a);
    padding: 3px 0 3px 8px;
  }

  .param {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .param-label {
    font-size: 9px;
    color: var(--panel-text-dim, #8a8a8a);
    letter-spacing: 0.05em;
    user-select: none;
  }

  input[type='number'] {
    width: 36px;
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
    font-size: 16px;
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
    align-self: flex-end;
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
