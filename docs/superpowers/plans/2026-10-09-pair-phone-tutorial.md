# Pair a phone tutorial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Yon desktop's Pair a phone sheet, ask whether the phone already has Yon and show a looping, literal phone animation of the right steps, so phones keep one Yon icon.

**Architecture:** A pure helper module (`src/pairFlow.ts`) decides the next step and shortens names; a presentational `PhoneTutorial` component draws an inline-SVG phone whose four scenes and the matching step highlight are driven only by CSS keyframes; `PairPhoneSheet` gains a two-button choice, an in-place "Turn on Reach from anywhere" step, and renders `PhoneTutorial` next to the QR.

**Tech Stack:** React 19 + TypeScript, plain CSS in `src/styles.css`, `bun test`, Tauri 2 (desktop shell).

Spec: `docs/superpowers/specs/2026-10-09-pair-phone-tutorial-design.md`.

## Global Constraints

- **No inline styles.** The release CSP is `style-src 'self'` (`src-tauri/tauri.conf.json:25`); `devCsp` allows `'unsafe-inline'`, so `style={{…}}` or `style="…"` works in `tauri dev` and silently breaks in release. Use classes only. SVG presentation attributes (`fill`, `stroke`, `rx`…) are fine.
- No new dependencies.
- Animate only `opacity` and `transform`.
- Loop: 4 scenes × 2 s = 8 s, infinite. Step 1 ↔ scene 1, step 2 ↔ scene 2, step 3 ↔ scenes 3 and 4 (both variants).
- `prefers-reduced-motion: reduce`: no animation, key scene shown (add: scene 2; new: scene 3), Pause/Play hidden.
- All motion CSS lives inside `@media (prefers-reduced-motion: no-preference)` (pattern already used in `src/styles.css`, e.g. line 978).
- The SVG is `aria-hidden="true"`; the `<ol className="steps">` is the accessible content.
- Button labels, exactly: `Yon is already on this phone`, `First time on this phone`, `Turn on Reach from anywhere`, `Back`, `Pause animation`, `Play animation`.
- "Pair again" (`replace` prop) behaviour unchanged.
- Code comments in English; `// WHY:` for non-obvious choices. Match file style (2 spaces, double quotes).

## File structure

| File | Responsibility |
|---|---|
| `src/pairFlow.ts` (new) | Pure: `nextPairStep`, `shortName` |
| `src/pairFlow.test.ts` (new) | Tests for the above |
| `src/components/PhoneTutorial.tsx` (new) | Phone SVG scenes + synced steps + Pause/Play |
| `src/styles.css` (modify, append) | `.tutorial*` styles and keyframes |
| `src/components/PairPhoneSheet.tsx` (modify) | Choice buttons, Turn-on step, renders `PhoneTutorial` |
| `src/App.tsx`, `src/components/SettingsSheet.tsx` (modify) | Pass `settings` to `PairPhoneSheet` |
| `docs/yon-link.md` (modify) | One paragraph on the two paths |

---

### Task 1: Helpers and the PhoneTutorial component (agent 1)

**Files:**
- Create: `src/pairFlow.ts`, `src/pairFlow.test.ts`, `src/components/PhoneTutorial.tsx`
- Modify: `src/styles.css` (append at end)

**Interfaces:**
- Produces:
  - `export type PairPath = "add" | "new";`
  - `export type PairStep = "pair" | "needs_remote" | "no_relay";`
  - `export function nextPairStep(path: PairPath, s: { remote: boolean; effective_relay: string | null }): PairStep`
  - `export function shortName(name: string, max = 18): string`
  - `export default function PhoneTutorial(props: { variant: PairPath; computer: string; steps: React.ReactNode[] }): JSX.Element` — `steps` has exactly 3 items.

- [ ] **Step 1: Write the failing test** `src/pairFlow.test.ts`

```ts
import { expect, test } from "bun:test";
import { nextPairStep, shortName } from "./pairFlow";

test("first time always pairs straight away", () => {
  expect(nextPairStep("new", { remote: false, effective_relay: null })).toBe("pair");
  expect(nextPairStep("new", { remote: true, effective_relay: "wss://r" })).toBe("pair");
});

test("adding to an existing icon needs Reach from anywhere", () => {
  expect(nextPairStep("add", { remote: true, effective_relay: "wss://r" })).toBe("pair");
  expect(nextPairStep("add", { remote: false, effective_relay: "wss://r" })).toBe("needs_remote");
  expect(nextPairStep("add", { remote: false, effective_relay: null })).toBe("no_relay");
});

test("remote on without a relay still can't add", () => {
  expect(nextPairStep("add", { remote: true, effective_relay: null })).toBe("no_relay");
});

test("shortName keeps short names and trims long ones with an ellipsis", () => {
  expect(shortName("Leo's MacBook")).toBe("Leo's MacBook");
  expect(shortName("A very long computer name here")).toBe("A very long comput…");
  expect(shortName("  padded  ")).toBe("padded");
  expect(shortName("abcdef", 3)).toBe("abc…");
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun test src/pairFlow.test.ts`
Expected: FAIL — cannot find module `./pairFlow`.

- [ ] **Step 3: Implement** `src/pairFlow.ts`

```ts
// Pair a phone: which step comes next, and short labels for the phone animation.
// Spec: docs/superpowers/specs/2026-10-09-pair-phone-tutorial-design.md

/** "add": the phone already has the Yon icon; "new": first time on this phone. */
export type PairPath = "add" | "new";
export type PairStep = "pair" | "needs_remote" | "no_relay";

/** WHY: Add computer on the phone only accepts relay codes, so "add" needs
 * Reach from anywhere on, and that needs a relay address. */
export function nextPairStep(path: PairPath, s: { remote: boolean; effective_relay: string | null }): PairStep {
  if (path === "new") return "pair";
  if (!s.effective_relay) return "no_relay";
  return s.remote ? "pair" : "needs_remote";
}

/** Fits a name into the phone mock's narrow label. */
export function shortName(name: string, max = 18): string {
  const t = name.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/pairFlow.test.ts`
Expected: 4 pass, 0 fail.

- [ ] **Step 5: Create** `src/components/PhoneTutorial.tsx`

```tsx
import { useState, type ReactNode } from "react";
import { LogoShapes } from "./Logo";
import { shortName, type PairPath } from "../pairFlow";

interface Props {
  variant: PairPath;
  /** This computer's name, shown on the last "add" scene. */
  computer: string;
  /** Exactly three steps; step 1 ↔ scene 1, step 2 ↔ scene 2, step 3 ↔ scenes 3–4. */
  steps: ReactNode[];
}

// Colours of the phone page (web/link.css, dark), fixed: the mock depicts that page.
const SCREEN = "#181b21";
const CARD = "#22262e";
const INK = "#eceef2";
const MUTED = "#8e95a5";
const ACCENT = "#f2b53a";

/** Literal phone mock that loops through the pairing steps (CSS-only motion). */
export default function PhoneTutorial({ variant, computer, steps }: Props) {
  const [paused, setPaused] = useState(false);
  const name = shortName(computer);
  // WHY: the key scene stays visible without motion (reduced motion / before CSS loads).
  const key = variant === "add" ? 1 : 2;
  const scenes = variant === "add" ? addScenes(name) : newScenes();
  return (
    <div className={`tutorial${paused ? " paused" : ""}`}>
      <div className="tutorial-phone">
        <svg viewBox="0 0 140 280" aria-hidden="true">
          <rect x="1" y="1" width="138" height="278" rx="24" className="tutorial-frame" />
          <rect x="7" y="7" width="126" height="266" rx="18" fill={SCREEN} />
          <rect x="52" y="12" width="36" height="9" rx="4.5" fill="#000" />
          {scenes.map((scene, i) => (
            <g key={i} className={`tutorial-scene s${i}${i === key ? " key" : ""}`}>
              {scene}
            </g>
          ))}
        </svg>
        <button
          type="button"
          className="link tutorial-toggle"
          onClick={() => setPaused(!paused)}
        >
          {paused ? "Play animation" : "Pause animation"}
        </button>
      </div>
      <ol className="steps tutorial-steps">
        {steps.map((step, i) => (
          <li key={i} className={`st${i}`}>
            {step}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Small Yon page header used by several scenes. */
function YonHeader({ y = 40 }: { y?: number }) {
  return (
    <g>
      <svg x="58" y={y} width="24" height="24" viewBox="195 30 130 130">
        <LogoShapes />
      </svg>
      <text x="70" y={y + 40} textAnchor="middle" fontSize="12" fontWeight="700" fill={INK}>
        Yon
      </text>
    </g>
  );
}

/** Finger tap: a ring that grows and fades (animated per scene in CSS). */
function Tap({ x, y }: { x: number; y: number }) {
  return <circle className="tutorial-tap" cx={x} cy={y} r="10" fill="none" stroke={ACCENT} strokeWidth="3" />;
}

/** QR-like square pattern (not a real code). */
function FakeQr({ x, y, size }: { x: number; y: number; size: number }) {
  const c = size / 7;
  const on = [0, 1, 2, 4, 6, 7, 9, 13, 14, 16, 18, 20, 21, 24, 26, 28, 30, 32, 34, 35, 37, 39, 40, 42, 44, 46, 48];
  return (
    <g>
      <rect x={x} y={y} width={size} height={size} fill="#fff" />
      {on.map((n) => (
        <rect key={n} x={x + (n % 7) * c} y={y + Math.floor(n / 7) * c} width={c} height={c} fill="#000" />
      ))}
    </g>
  );
}

function HomeScreen({ withYon }: { withYon: boolean }) {
  const apps = [0, 1, 2, 3, 4, 5, 6, 7];
  return (
    <g>
      {apps.map((i) => (
        <rect key={i} x={18 + (i % 4) * 27} y={40 + Math.floor(i / 4) * 34} width="20" height="20" rx="5" fill="#3a404b" />
      ))}
      {withYon && (
        <g className="tutorial-newicon">
          <svg x="18" y="108" width="20" height="20" viewBox="195 30 130 130">
            <LogoShapes />
          </svg>
          <text x="28" y="137" textAnchor="middle" fontSize="6" fill={INK}>
            Yon
          </text>
        </g>
      )}
    </g>
  );
}

function addScenes(name: string): ReactNode[] {
  return [
    // 1: Home Screen, tap the Yon icon
    <g>
      <HomeScreen withYon />
      <Tap x={28} y={118} />
    </g>,
    // 2: Yon page, tap Add computer
    <g>
      <YonHeader />
      <rect x="20" y="104" width="100" height="26" rx="8" fill={ACCENT} />
      <text x="70" y="121" textAnchor="middle" fontSize="9" fontWeight="700" fill={SCREEN}>
        Send photos & files
      </text>
      <rect x="30" y="140" width="80" height="20" rx="7" fill="none" stroke={MUTED} />
      <text x="70" y="153" textAnchor="middle" fontSize="8" fill={INK}>
        Add computer
      </text>
      <Tap x={70} y={150} />
    </g>,
    // 3: camera framing the code on the computer
    <g>
      <rect x="7" y="7" width="126" height="266" rx="18" fill="#000" />
      <FakeQr x={42} y={102} size={56} />
      <rect x="34" y="94" width="72" height="72" rx="8" fill="none" stroke={ACCENT} strokeWidth="2.5" />
      <rect className="tutorial-sweep" x="38" y="98" width="64" height="2" fill={ACCENT} />
      <text x="70" y="196" textAnchor="middle" fontSize="7" fill={INK}>
        Point at the QR code
      </text>
    </g>,
    // 4: the computer is in the list
    <g>
      <YonHeader />
      <rect x="16" y="104" width="108" height="34" rx="8" fill={CARD} />
      <text x="26" y="125" fontSize="9" fill={INK}>
        {name}
      </text>
      <circle cx="112" cy="121" r="7" fill="#5cc596" />
      <path d="M108.5 121 l2.5 2.5 l4.5 -5" fill="none" stroke={SCREEN} strokeWidth="2" />
      <text x="70" y="160" textAnchor="middle" fontSize="7" fill={MUTED}>
        Added
      </text>
    </g>,
  ];
}

function newScenes(): ReactNode[] {
  return [
    // 1: Camera app framing the code
    <g>
      <rect x="7" y="7" width="126" height="266" rx="18" fill="#000" />
      <FakeQr x={42} y={102} size={56} />
      <rect x="34" y="94" width="72" height="72" rx="8" fill="none" stroke="#fff" strokeWidth="2" />
    </g>,
    // 2: link banner, tap
    <g>
      <rect x="7" y="7" width="126" height="266" rx="18" fill="#000" />
      <FakeQr x={42} y={102} size={56} />
      <rect x="16" y="190" width="108" height="24" rx="12" fill="#f2f2f2" />
      <text x="70" y="205" textAnchor="middle" fontSize="7" fill="#111">
        yon.meo.in.th
      </text>
      <Tap x={70} y={202} />
    </g>,
    // 3: Share sheet, Add to Home Screen
    <g>
      <YonHeader y={30} />
      <rect x="10" y="150" width="120" height="116" rx="14" fill={CARD} />
      <text x="20" y="176" fontSize="8" fill={MUTED}>
        Copy
      </text>
      <rect x="16" y="188" width="108" height="22" rx="6" fill="#323741" />
      <text x="24" y="202" fontSize="8" fill={INK}>
        Add to Home Screen
      </text>
      <Tap x={70} y={199} />
    </g>,
    // 4: Home Screen with the new Yon icon
    <g>
      <HomeScreen withYon />
    </g>,
  ];
}
```

- [ ] **Step 6: Append styles** to the end of `src/styles.css`

```css
/* ---- Pair a phone: phone animation (spec 2026-10-09-pair-phone-tutorial) ---- */
.tutorial {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  margin: 12px 0;
}
.tutorial-phone {
  flex: none;
  width: 140px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.tutorial-phone svg {
  width: 140px;
  height: 280px;
}
.tutorial-frame {
  fill: var(--avatar);
  stroke: var(--line);
  stroke-width: 2;
}
.tutorial-steps {
  flex: 1;
  margin: 0;
}
.tutorial-steps li {
  transition: color 0.2s;
}
/* WHY: without motion the key scene (the one action that matters) is shown still. */
.tutorial-scene {
  opacity: 0;
}
.tutorial-scene.key {
  opacity: 1;
}
.tutorial-tap,
.tutorial-sweep {
  opacity: 0;
}
.tutorial-toggle {
  display: none;
}
@media (max-width: 420px) {
  .tutorial {
    flex-direction: column;
    align-items: center;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .tutorial-toggle {
    display: inline;
  }
  /* WHY: negative delays start each scene at its own slot of the 8 s loop. */
  .tutorial-scene {
    animation: tutorial-scene 8s linear infinite;
  }
  .tutorial-scene.s0 { animation-delay: 0s; }
  .tutorial-scene.s1 { animation-delay: -6s; }
  .tutorial-scene.s2 { animation-delay: -4s; }
  .tutorial-scene.s3 { animation-delay: -2s; }
  .tutorial-scene .tutorial-tap {
    transform-box: fill-box;
    transform-origin: center;
    animation: tutorial-tap 8s ease-out infinite;
    animation-delay: inherit;
  }
  .tutorial-scene .tutorial-sweep {
    animation: tutorial-sweep 8s ease-in-out infinite;
    animation-delay: inherit;
  }
  .tutorial-steps li {
    animation: tutorial-step 8s linear infinite;
  }
  .tutorial-steps li.st0 { animation-delay: 0s; }
  .tutorial-steps li.st1 { animation-delay: -6s; }
  .tutorial-steps li.st2 { animation-name: tutorial-step-long; animation-delay: -4s; }
  .tutorial.paused * {
    animation-play-state: paused;
  }

  @keyframes tutorial-scene {
    0% { opacity: 0; }
    3% { opacity: 1; }
    22% { opacity: 1; }
    25% { opacity: 0; }
    100% { opacity: 0; }
  }
  @keyframes tutorial-tap {
    0%, 10% { opacity: 0; transform: scale(0.4); }
    12% { opacity: 0.9; transform: scale(0.6); }
    20% { opacity: 0; transform: scale(1.6); }
    100% { opacity: 0; transform: scale(1.6); }
  }
  @keyframes tutorial-sweep {
    0%, 3% { opacity: 0; transform: translateY(0); }
    5% { opacity: 1; }
    20% { opacity: 1; transform: translateY(62px); }
    22%, 100% { opacity: 0; transform: translateY(62px); }
  }
  @keyframes tutorial-step {
    0%, 24% { color: var(--ink); }
    25%, 100% { color: var(--muted); }
  }
  @keyframes tutorial-step-long {
    0%, 49% { color: var(--ink); }
    50%, 100% { color: var(--muted); }
  }
}
```

Note: `animation-delay: inherit` on `.tutorial-tap` / `.tutorial-sweep` takes the scene group's delay, so a tap happens inside its own scene.

- [ ] **Step 7: Typecheck and lint**

Run: `bun run typecheck && bun run lint && bun test src/`
Expected: exit 0; pairFlow tests pass; existing tests pass.

- [ ] **Step 8: Do not commit** (the coordinator reviews and commits).

---

### Task 2: PairPhoneSheet flow and callers (agent 2)

**Files:**
- Modify: `src/components/PairPhoneSheet.tsx`
- Modify: `src/App.tsx:578-583`, `src/components/SettingsSheet.tsx:341-347`
- Modify: `docs/yon-link.md` (section "Pair a phone (once)")

**Interfaces:**
- Consumes (from Task 1, exact): `nextPairStep(path, { remote, effective_relay })`, types `PairPath`, `PairStep` from `src/pairFlow.ts`; `PhoneTutorial` default export from `src/components/PhoneTutorial.tsx` with props `{ variant: PairPath; computer: string; steps: ReactNode[] }` (exactly 3 steps).
- Existing: `api.setRemote(enabled: boolean, relayUrl: string): Promise<Settings>`, `Settings` fields `device_name`, `remote`, `relay_url`, `effective_relay` (`src/api.ts`).
- Produces: `PairPhoneSheet` prop `settings: Settings` (new, required).

- [ ] **Step 1: Add the prop and pass it from both callers**

In `PairPhoneSheet.tsx` `Props`: add
```ts
  /** For the computer's name and Reach from anywhere (Add to an existing Yon icon needs it). */
  settings: Settings;
```
`App.tsx` and `SettingsSheet.tsx`: add `settings={state.settings}` to `<PairPhoneSheet …>`.
Destructure it in the component signature: `({ online, phones, replace, settings, onPaired, onClose }: Props)`.

- [ ] **Step 2: State for the chosen path and the remote step**

```ts
  const [path, setPath] = useState<PairPath>("new");
  /** Shown instead of the name form when "add" needs Reach from anywhere first. */
  const [needsRemote, setNeedsRemote] = useState<PairStep | null>(null);
```

- [ ] **Step 3: Replace `pair(e)` with a choice-aware version**

```ts
  async function pair(chosen: PairPath) {
    setError(null);
    setPath(chosen);
    const step = replace ? "pair" : nextPairStep(chosen, settings);
    if (step !== "pair") return setNeedsRemote(step);
    setBusy(true);
    try {
      const p = await api.pairPhone(name, replace?.id);
      setNeedsRemote(null);
      setQr({ id: p.phone_id, main: p.qr, fallback: p.fallback, anywhere: p.anywhere });
      onPaired(p.settings);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function turnOnRemote() {
    setError(null);
    setBusy(true);
    try {
      const s = await api.setRemote(true, settings.relay_url);
      onPaired(s);
      // WHY: pair only after the setting is saved, so the code goes through the relay.
      const p = await api.pairPhone(name, replace?.id);
      setNeedsRemote(null);
      setQr({ id: p.phone_id, main: p.qr, fallback: p.fallback, anywhere: p.anywhere });
      onPaired(p.settings);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
```

The form's `onSubmit` becomes `(e) => { e.preventDefault(); void pair("new"); }` (Enter in the name field = first-time path, same as today's default).

- [ ] **Step 4: Name form buttons**

Non-replace: replace the single `Show code` submit with:
```tsx
<div className="actions">
  <button type="button" className="quiet" onClick={onClose}>Cancel</button>
  <button type="button" className="quiet" disabled={busy} onClick={() => void pair("add")}>
    Yon is already on this phone
  </button>
  <button type="submit" className="primary" disabled={busy}>
    First time on this phone
  </button>
</div>
```
Replace mode (`replace` set): keep today's `Show code` button and call `pair("new")`.

- [ ] **Step 5: Remote step screen** (rendered when `needsRemote !== null` and no QR yet)

```tsx
<div className="pair">
  <h2 id="pair-title">Turn on Reach from anywhere</h2>
  <p className="hint">
    Adding this computer to the Yon icon you already have needs Reach from anywhere on this computer.
  </p>
  {needsRemote === "no_relay" && (
    <p className="hint">Set a relay address in Settings → Advanced first.</p>
  )}
  {error && <p className="hint bad">{error}</p>}
  <div className="actions">
    <button type="button" className="quiet" onClick={() => setNeedsRemote(null)}>Back</button>
    <button
      type="button"
      className="primary"
      disabled={busy || needsRemote === "no_relay"}
      onClick={() => void turnOnRemote()}
    >
      Turn on Reach from anywhere
    </button>
  </div>
</div>
```

- [ ] **Step 6: QR screen uses PhoneTutorial**

Replace the `<ol className="steps">…</ol>` with:
- `path === "add"` (and not `replace`): heading `Add to Yon on {name}`;
```tsx
<PhoneTutorial
  variant="add"
  computer={settings.device_name}
  steps={[
    <>Open the <b>Yon</b> icon on the phone.</>,
    <>Tap <b>Add computer</b>.</>,
    <>Point the phone at this code.</>,
  ]}
/>
<p className="hint">Don't scan with the Camera app: that adds a second Yon icon.</p>
```
  and do not render the "Link doesn't open?" fallback button.
- otherwise: heading unchanged (`Scan with {name}`) and `<PhoneTutorial variant="new" computer={settings.device_name} steps={[…today's three <li> contents…]} />`. In replace mode keep today's third step text ("Keep this window open…").

- [ ] **Step 7: Docs** — in `docs/yon-link.md` "Pair a phone (once)", after step 1 add: "Yon asks whether the phone already has the Yon icon. If it does (paired with another computer), choose **Yon is already on this phone**: on the phone, open Yon, tap **Add computer** and scan. That keeps one Yon icon for all your computers. This needs Reach from anywhere; Yon offers to turn it on."

- [ ] **Step 8: Verify**

Run: `bun run typecheck && bun run lint && bun test src/`
Expected: exit 0.

- [ ] **Step 9: Do not commit** (the coordinator reviews and commits).

---

### Task 3: Review, visual check, commit (coordinator)

- [ ] Review both diffs against the spec and Global Constraints (grep for `style=` in changed files: must be none).
- [ ] `bun run typecheck && bun run lint && bun test web/ relay/ src/ website/ && bun run build`
- [ ] `bun run tauri dev`: screenshots of both paths (light/dark), remote-off → Turn on, reduced motion.
- [ ] Commit on `feat/pair-tutorial`, push, PR (no "Generated with" line).
