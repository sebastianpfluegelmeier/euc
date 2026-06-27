<script lang="ts">
  import { onDestroy } from 'svelte';

  interface ChainStep { len: number; steps: number; div: number; offset: number; reps: number; }
  interface Lane { id: number; chain: ChainStep[]; sample: AudioBuffer | null; sampleName: string; }
  interface LaneRt { chainIdx: number; repsDone: number; stepIdx: number; nextStepTime: number; }

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

  let _id = 0;
  const newCs = (): ChainStep => ({ len: 16, steps: 4, div: 4, offset: 0, reps: 1 });
  const newLane = (): Lane => ({ id: _id++, chain: [newCs()], sample: null, sampleName: 'CLK' });

  let bpm = $state(120);
  let playing = $state(false);
  let lanes = $state<Lane[]>([newLane()]);
  let currentSteps = $state<Record<number, number>>({});
  let activeChainIdxs = $state<Record<number, number>>({});

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
    const lookahead = 0.12;
    const now = audioCtx.currentTime;

    for (const lane of lanes) {
      let rt = rts.get(lane.id);
      if (!rt) {
        rt = { chainIdx: 0, repsDone: 0, stepIdx: 0, nextStepTime: now };
        rts.set(lane.id, rt);
      }

      while (rt.nextStepTime < now + lookahead) {
        const ci = Math.min(rt.chainIdx, lane.chain.length - 1);
        const cs = lane.chain[ci];
        if (!cs) break;
        if (rt.stepIdx >= cs.len) rt.stepIdx = 0;

        const pat = rotate(bjorklund(cs.steps, cs.len), cs.offset);
        const isActive = pat[rt.stepIdx] ?? false;

        if (isActive) {
          if (lane.sample) playBuffer(audioCtx!, lane.sample, rt.nextStepTime);
          else fireClick(audioCtx!, rt.nextStepTime, rt.stepIdx === 0);
        }

        const sid = rt.stepIdx, lid = lane.id;
        const delay = Math.max(0, (rt.nextStepTime - now) * 1000 - 10);
        setTimeout(() => { currentSteps[lid] = sid; }, delay);

        rt.nextStepTime += 60 / bpm / cs.div;
        rt.stepIdx++;

        if (rt.stepIdx >= cs.len) {
          rt.stepIdx = 0;
          rt.repsDone++;
          if (rt.repsDone >= cs.reps) {
            rt.repsDone = 0;
            const prevCi = rt.chainIdx;
            rt.chainIdx = (rt.chainIdx + 1) % Math.max(1, lane.chain.length);
            if (rt.chainIdx !== prevCi) {
              const newCi = rt.chainIdx, lid2 = lane.id;
              setTimeout(() => { activeChainIdxs[lid2] = newCi; }, delay);
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
    for (const lane of lanes) rts.set(lane.id, { chainIdx: 0, repsDone: 0, stepIdx: 0, nextStepTime: t0 });
    currentSteps = {}; activeChainIdxs = {};
    playing = true; schedule();
  }

  function stop() {
    playing = false;
    if (schedulerTimer !== null) { clearTimeout(schedulerTimer); schedulerTimer = null; }
    currentSteps = {};
  }

  function togglePlay() { if (playing) stop(); else start(); }

  onDestroy(() => {
    if (schedulerTimer !== null) clearTimeout(schedulerTimer);
    audioCtx?.close();
  });

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

  function addLane() { lanes = [...lanes, newLane()]; }
  function removeLane(id: number) { if (lanes.length > 1) lanes = lanes.filter(l => l.id !== id); }

  function addChainStep(lane: Lane) {
    lane.chain = [...lane.chain, { ...lane.chain[lane.chain.length - 1] }];
  }

  function removeChainStep(lane: Lane, i: number) {
    if (lane.chain.length <= 1) return;
    lane.chain = lane.chain.filter((_, j) => j !== i);
    const rt = rts.get(lane.id);
    if (rt && rt.chainIdx >= lane.chain.length) {
      rt.chainIdx = 0; rt.repsDone = 0; rt.stepIdx = 0;
      activeChainIdxs[lane.id] = 0;
    }
  }
</script>

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
    {@const activeCi = activeChainIdxs[lane.id] ?? 0}
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

      {#each lane.chain as cs, ci}
        {@const pat = rotate(bjorklund(cs.steps, cs.len), cs.offset)}
        {@const isCurrent = activeCi === ci}
        <div class="chain-step" class:chain-current={isCurrent}>
          <div class="euc-viz">
            {#each pat as active, si}
              <div class="step"
                class:active
                class:downbeat={si === 0}
                class:current={currentSteps[lane.id] === si && isCurrent}
              ></div>
            {/each}
          </div>
          <div class="cs-params-box">
          <div class="cs-params">
            <div class="param">
              <span class="param-label">L</span>
              <input type="number" value={cs.len} min="1" max="64"
                onpointerdown={(e) => onNumDown(e, () => cs.len)}
                onpointermove={(e) => onNumMove(e, (v) => { cs.len = v; cs.steps = Math.min(cs.steps, v); }, 1, 64)}
                onpointerup={onNumUp}
                oninput={(e) => { if (!drag?.moved) { const v = Math.max(1, Math.min(64, +((e.currentTarget as HTMLInputElement).value) || 1)); cs.len = v; cs.steps = Math.min(cs.steps, v); } }}
              />
            </div>
            <div class="param">
              <span class="param-label">S</span>
              <input type="number" value={cs.steps} min="0" max={cs.len}
                onpointerdown={(e) => onNumDown(e, () => cs.steps)}
                onpointermove={(e) => onNumMove(e, (v) => { cs.steps = v; }, 0, cs.len)}
                onpointerup={onNumUp}
                oninput={(e) => { if (!drag?.moved) cs.steps = Math.max(0, Math.min(cs.len, +((e.currentTarget as HTMLInputElement).value))); }}
              />
            </div>
            <div class="param">
              <span class="param-label">D</span>
              <input type="number" value={cs.div} min="1" max="32"
                onpointerdown={(e) => onNumDown(e, () => cs.div)}
                onpointermove={(e) => onNumMove(e, (v) => { cs.div = v; }, 1, 32)}
                onpointerup={onNumUp}
                oninput={(e) => { if (!drag?.moved) cs.div = Math.max(1, Math.min(32, +((e.currentTarget as HTMLInputElement).value) || 1)); }}
              />
            </div>
            <div class="param">
              <span class="param-label">O</span>
              <input type="number" value={cs.offset} min="0" max="63"
                onpointerdown={(e) => onNumDown(e, () => cs.offset)}
                onpointermove={(e) => onNumMove(e, (v) => { cs.offset = v; }, 0, 63)}
                onpointerup={onNumUp}
                oninput={(e) => { if (!drag?.moved) cs.offset = Math.max(0, Math.min(63, +((e.currentTarget as HTMLInputElement).value))); }}
              />
            </div>
            <div class="param">
              <span class="param-label">R</span>
              <input type="number" value={cs.reps} min="1" max="16"
                onpointerdown={(e) => onNumDown(e, () => cs.reps)}
                onpointermove={(e) => onNumMove(e, (v) => { cs.reps = v; }, 1, 16)}
                onpointerup={onNumUp}
                oninput={(e) => { if (!drag?.moved) cs.reps = Math.max(1, Math.min(16, +((e.currentTarget as HTMLInputElement).value) || 1)); }}
              />
            </div>
            {#if lane.chain.length > 1}
              <button class="icon-btn remove-cs" onclick={() => removeChainStep(lane, ci)}>×</button>
            {/if}
          </div>
          </div>
        </div>
      {/each}

      <button class="add-btn" onclick={() => addChainStep(lane)}>+ STEP</button>
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
    margin-bottom: 0;
  }

  .lanes-body {
    padding: 12px;
  }

  .title {
    font-size: 9px;
    letter-spacing: 0.12em;
    color: var(--panel-text-dim, #8a8a8a);
  }

  .transport {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .lane {
    background: var(--surface-raised, #262626);
    padding: 8px;
    margin-bottom: 8px;
  }

  .lane-hdr {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .sample-btn {
    font-family: var(--term-font, 'JetBrains Mono', monospace);
    font-size: 9px;
    letter-spacing: 0.08em;
    color: var(--panel-text-dim, #8a8a8a);
    background: var(--surface-bg, #1a1a1a);
    border: 1px solid #333;
    padding: 2px 6px;
    cursor: pointer;
    display: inline-block;
  }

  .sample-btn:hover {
    border-color: var(--panel-text-dim, #8a8a8a);
    color: var(--panel-text, #e8e8e8);
  }

  .hidden-file { display: none; }

  .chain-step {
    margin-bottom: 6px;
    border-left: 2px solid transparent;
    padding-left: 4px;
  }

  .chain-step.chain-current { border-left-color: var(--accent, #ff2050); }

  .euc-viz {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    margin-bottom: 4px;
    min-height: 9px;
  }

  .step {
    width: 9px; height: 9px;
    background: #3a3a3a;
    flex-shrink: 0;
  }

  .step.active { background: #5a5a5a; }
  .step.downbeat { background: var(--panel-text, #e8e8e8); }
  .step.current { outline: 1px solid var(--accent, #ff2050); outline-offset: -1px; }
  .step.current.active, .step.current.downbeat { background: var(--accent, #ff2050); outline: none; }

  .cs-params-box {
    background: var(--surface-bg, #1a1a1a);
    padding: 6px;
    margin-top: 2px;
  }

  .cs-params {
    display: flex;
    gap: 4px;
    align-items: flex-end;
    flex-wrap: wrap;
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

  input[type='number']:focus { border-color: var(--panel-text-dim, #8a8a8a); cursor: text; }

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

  .play-btn:hover { border-color: var(--panel-text-dim, #8a8a8a); }
  .play-btn.is-playing { color: var(--accent, #ff2050); border-color: var(--accent, #ff2050); }

  .icon-btn {
    background: transparent;
    border: none;
    color: var(--panel-text-dim, #8a8a8a);
    font-family: var(--term-font, 'JetBrains Mono', monospace);
    font-size: 16px;
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
  }

  .icon-btn:hover { color: var(--panel-text, #e8e8e8); }

  .remove-cs {
    align-self: flex-end;
    padding-bottom: 1px;
  }

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
    margin-top: 2px;
    display: block;
    box-sizing: border-box;
  }

  .add-btn:hover {
    border-color: var(--panel-text-dim, #8a8a8a);
    color: var(--panel-text, #e8e8e8);
  }

  .add-lane-btn { margin-top: 0; }
</style>
