<script lang="ts">
  import { onDestroy } from 'svelte';

  function bjorklund(k: number, n: number): boolean[] {
    n = n | 0;
    k = Math.max(0, Math.min(k | 0, n));
    if (n <= 0) return [];
    const p: boolean[] = new Array(n);
    for (let i = 0; i < n; i++) {
      p[i] = Math.floor(((i + 1) * k) / n) > Math.floor((i * k) / n);
    }
    return p;
  }

  function rotate(p: boolean[], off: number): boolean[] {
    const n = p.length;
    if (!n) return [];
    const o = ((off | 0) % n + n) % n;
    return o === 0 ? p.slice() : [...p.slice(o), ...p.slice(0, o)];
  }

  let gen = $state({ len: 16, steps: 4, div: 4, offset: 0 });
  let bpm = $state(120);
  let playing = $state(false);
  let currentStep = $state(-1);

  let pattern = $derived(rotate(bjorklund(gen.steps, gen.len), gen.offset));

  let audioCtx: AudioContext | null = null;
  let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  let nextStepTime = 0;
  let stepIndex = 0;

  function fireClick(ctx: AudioContext, at: number, accent: boolean) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'triangle';
    osc.frequency.value = accent ? 1400 : 800;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(accent ? 0.45 : 0.25, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
    osc.start(at);
    osc.stop(at + 0.05);
  }

  function schedule() {
    if (!audioCtx || !playing) return;
    const lookahead = 0.12;
    const n = Math.max(1, gen.len);
    const pat = rotate(bjorklund(gen.steps, gen.len), gen.offset);
    while (nextStepTime < audioCtx.currentTime + lookahead) {
      stepIndex = stepIndex % n;
      const isActive = pat[stepIndex] ?? false;
      if (isActive) fireClick(audioCtx, nextStepTime, stepIndex === 0);
      const si = stepIndex;
      const delay = (nextStepTime - audioCtx.currentTime) * 1000 - 10;
      setTimeout(() => { currentStep = si; }, Math.max(0, delay));
      nextStepTime += 60 / bpm / gen.div;
      stepIndex = (stepIndex + 1) % n;
    }
    schedulerTimer = setTimeout(schedule, 20);
  }

  function start() {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    stepIndex = 0;
    currentStep = -1;
    nextStepTime = audioCtx.currentTime + 0.05;
    playing = true;
    schedule();
  }

  function stop() {
    playing = false;
    if (schedulerTimer !== null) { clearTimeout(schedulerTimer); schedulerTimer = null; }
    currentStep = -1;
  }

  function togglePlay() {
    if (playing) stop(); else start();
  }

  onDestroy(() => {
    if (schedulerTimer !== null) clearTimeout(schedulerTimer);
    if (audioCtx) audioCtx.close();
  });

  type Drag = { y0: number; v0: number; moved: boolean } | null;
  let drag: Drag = null;

  function onNumDown(e: PointerEvent, getV: () => number) {
    drag = { y0: e.clientY, v0: getV(), moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onNumMove(e: PointerEvent, setV: (v: number) => void, lo: number, hi: number) {
    if (!drag || !(e.buttons & 1)) return;
    const dy = drag.y0 - e.clientY;
    if (!drag.moved && Math.abs(dy) > 3) {
      drag.moved = true;
      (e.currentTarget as HTMLElement).blur();
    }
    if (drag.moved) setV(Math.max(lo, Math.min(hi, drag.v0 + Math.round(dy / 4))));
  }

  function onNumUp() { drag = null; }
</script>

<div class="euc-panel">
  <div class="euc-header">EUCLIDEAN</div>

  <div class="euc-viz">
    {#each pattern as active, i}
      <div
        class="step"
        class:active
        class:downbeat={i === 0}
        class:current={i === currentStep}
      ></div>
    {/each}
  </div>

  <div class="euc-params">
    <div class="param">
      <span class="param-label">LEN</span>
      <input
        type="number" value={gen.len} min="1" max="64"
        onpointerdown={(e) => onNumDown(e, () => gen.len)}
        onpointermove={(e) => onNumMove(e, (v) => { gen.len = v; gen.steps = Math.min(gen.steps, v); }, 1, 64)}
        onpointerup={onNumUp}
        oninput={(e) => {
          if (!drag?.moved) {
            const v = Math.max(1, Math.min(64, Number((e.currentTarget as HTMLInputElement).value) || 1));
            gen.len = v;
            gen.steps = Math.min(gen.steps, v);
          }
        }}
      />
    </div>
    <div class="param">
      <span class="param-label">STEPS</span>
      <input
        type="number" value={gen.steps} min="0" max={gen.len}
        onpointerdown={(e) => onNumDown(e, () => gen.steps)}
        onpointermove={(e) => onNumMove(e, (v) => { gen.steps = v; }, 0, gen.len)}
        onpointerup={onNumUp}
        oninput={(e) => {
          if (!drag?.moved)
            gen.steps = Math.max(0, Math.min(gen.len, Number((e.currentTarget as HTMLInputElement).value)));
        }}
      />
    </div>
    <div class="param">
      <span class="param-label">DIV</span>
      <input
        type="number" value={gen.div} min="1" max="32"
        onpointerdown={(e) => onNumDown(e, () => gen.div)}
        onpointermove={(e) => onNumMove(e, (v) => { gen.div = v; }, 1, 32)}
        onpointerup={onNumUp}
        oninput={(e) => {
          if (!drag?.moved)
            gen.div = Math.max(1, Math.min(32, Number((e.currentTarget as HTMLInputElement).value) || 1));
        }}
      />
    </div>
    <div class="param">
      <span class="param-label">OFF</span>
      <input
        type="number" value={gen.offset} min="0" max="63"
        onpointerdown={(e) => onNumDown(e, () => gen.offset)}
        onpointermove={(e) => onNumMove(e, (v) => { gen.offset = v; }, 0, 63)}
        onpointerup={onNumUp}
        oninput={(e) => {
          if (!drag?.moved)
            gen.offset = Math.max(0, Math.min(63, Number((e.currentTarget as HTMLInputElement).value)));
        }}
      />
    </div>
  </div>

  <div class="euc-transport">
    <div class="param">
      <span class="param-label">BPM</span>
      <input
        type="number" value={bpm} min="20" max="300"
        onpointerdown={(e) => onNumDown(e, () => bpm)}
        onpointermove={(e) => onNumMove(e, (v) => { bpm = v; }, 20, 300)}
        onpointerup={onNumUp}
        oninput={(e) => {
          if (!drag?.moved)
            bpm = Math.max(20, Math.min(300, Number((e.currentTarget as HTMLInputElement).value) || 120));
        }}
      />
    </div>
    <button class="play-btn" class:is-playing={playing} onclick={togglePlay}>
      {playing ? '‖' : '▶'}
    </button>
    <button class="play-btn" onclick={() => location.reload()}>↺</button>
  </div>
</div>

<style>
  .euc-panel {
    background: var(--surface-raised, #262626);
    padding: 12px;
    width: 240px;
    box-sizing: border-box;
    font-family: var(--term-font, 'JetBrains Mono', 'Courier New', monospace);
    color: var(--panel-text, #e8e8e8);
  }

  .euc-header {
    font-size: 9px;
    letter-spacing: 0.12em;
    color: var(--panel-text-dim, #8a8a8a);
    margin-bottom: 10px;
  }

  .euc-viz {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    margin-bottom: 10px;
    min-height: 9px;
  }

  .step {
    width: 9px;
    height: 9px;
    background: #3a3a3a;
    flex-shrink: 0;
  }

  .step.active { background: #5a5a5a; }
  .step.downbeat { background: var(--panel-text, #e8e8e8); }

  .step.current {
    outline: 1px solid var(--accent, #ff2050);
    outline-offset: -1px;
  }
  .step.current.active,
  .step.current.downbeat {
    background: var(--accent, #ff2050);
    outline: none;
  }

  .euc-params {
    display: flex;
    gap: 8px;
    margin-bottom: 10px;
  }

  .euc-transport {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }

  .param {
    display: flex;
    flex-direction: column;
    gap: 3px;
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
    font-size: 13px;
    padding: 3px 5px;
    border-radius: 0;
    outline: none;
    cursor: ns-resize;
    appearance: textfield;
    -moz-appearance: textfield;
    box-sizing: border-box;
  }

  input[type='number']::-webkit-outer-spin-button,
  input[type='number']::-webkit-inner-spin-button {
    -webkit-appearance: none;
  }

  input[type='number']:focus {
    border-color: var(--panel-text-dim, #8a8a8a);
    cursor: text;
  }

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

  .play-btn:hover {
    border-color: var(--panel-text-dim, #8a8a8a);
  }

  .play-btn.is-playing {
    color: var(--accent, #ff2050);
    border-color: var(--accent, #ff2050);
  }
</style>
