# Pair a phone: animated steps that keep one Yon icon

**Status:** Approved (2026-10-09)
**Builds on:** 2026-10-09-phone-many-computers (keyring + Add computer)

## Problem

**Settings → Phones → Pair a phone** tells everyone to scan with the Camera
app and Add to Home Screen (`src/components/PairPhoneSheet.tsx`, the QR
step's `<ol className="steps">`). A phone that already has Yon from another
computer then gets a second Yon icon. The right path for that phone is
inside its existing icon: **Add computer** → scan. The desktop can't tell
which case it is, so it asks.

## Decisions

1. **Ask before showing the code.** The name form's single "Show code"
   button becomes two submit buttons: **Yon is already on this phone** and
   **First time on this phone**. Same number of clicks as today.
2. **Literal animation** of the phone screens (inline SVG + CSS keyframes,
   no dependency): the mock uses the real Yon page's look and labels.
3. **"Already on this phone" needs Reach from anywhere** (Add computer only
   accepts relay codes). If it's off, the sheet offers **Turn on** in place,
   then continues to the code.
4. "Pair again" (`replace` prop) is unchanged.

## Flow (PairPhoneSheet, non-replace)

```
name form ── [Yon is already on this phone] ─┬─ remote on ──► pair → QR + PhoneTutorial "add"
          │                                  └─ remote off ─► "Needs Reach from anywhere" [Turn on]
          │                                                    └─ setRemote(true) ok ──► pair → QR + "add"
          └─ [First time on this phone] ──────────────────────► pair → QR + PhoneTutorial "new"
```

- `pair()` is unchanged except it records the chosen path (`"add" | "new"`).
- Remote off: text "Adding to the Yon icon you already have needs Reach
  from anywhere on this computer." Button **Turn on Reach from anywhere**
  calls `api.setRemote(true, settings.relay_url)`, passes the returned
  settings to `onPaired`, then runs `pair()`. If `settings.effective_relay`
  is `null` the button is disabled and the hint says "Set a relay address
  in Settings → Advanced first." Errors use `errorText` in the existing
  `hint bad` line. Back returns to the name form.
- QR step, path "add": heading "Add to Yon on {name}", steps:
  1. Open the **Yon** icon on the phone.
  2. Tap **Add computer**.
  3. Point the phone at this code.
  Plus a warning hint: "Don't scan with the Camera app: that adds a second
  Yon icon."
- QR step, path "new": today's three steps, unchanged text.
- The "Link doesn't open? Try this code instead" fallback stays for "new"
  only (Add computer refuses home-Wi-Fi codes).
- Paired confirmation: unchanged.

`PairPhoneSheet` gains a `settings: Settings` prop (needs `device_name`,
`remote`, `relay_url`, `effective_relay`). Callers: `src/App.tsx`,
`src/components/SettingsSheet.tsx`.

## PhoneTutorial component (`src/components/PhoneTutorial.tsx`)

```ts
interface Props {
  variant: "new" | "add";
  /** This computer's name, shown on the last "add" scene. */
  computer: string;
  /** Step texts; the active one is highlighted in sync with the scenes. */
  steps: React.ReactNode[];
}
```

- Layout: a phone mock (~140 × 280 px, rounded frame) on the left, the
  `<ol className="steps">` on the right; stacks on narrow widths.
- One loop, 4 scenes × 2 s = 8 s, `animation-iteration-count: infinite`.
  Scenes cross-fade (opacity); the tap indicator scales (transform). Only
  `opacity` and `transform` are animated.
- Scenes, variant **add**: (1) Home Screen with the Yon icon, tap on it;
  (2) Yon page with **Add computer**, tap on it; (3) camera view with a QR
  in a scan frame, a sweep line; (4) Yon page listing "{computer}" with a
  check.
- Scenes, variant **new**: (1) Camera app framing a QR; (2) the link
  banner, tap, Yon page opens; (3) Share sheet with **Add to Home Screen**,
  tap; (4) Home Screen with the new Yon icon appearing.
- Step highlight: in both variants step 1 → scene 1, step 2 → scene 2,
  step 3 → scenes 3 and 4, through CSS animation on each `<li>` with the same
  8 s duration and per-step delays; the highlighted step gets the accent
  colour and weight. No JS timers.
- **Pause/Play** button under the phone (WCAG 2.2.2): toggles
  `animation-play-state: paused` via a class; label "Pause animation" /
  "Play animation".
- `prefers-reduced-motion: reduce`: no animation; the phone shows the key
  scene (add: scene 2, Add computer; new: scene 3, Add to Home Screen) and no step is highlighted; the
  Pause/Play button is hidden.
- Accessibility: the SVG is `aria-hidden="true"`; the `<ol>` is the content.
- Colours: phone screen uses fixed dark Yon-page colours (it depicts the
  phone page); frame and highlight use theme tokens (`--line`, `--accent`,
  `--muted`), so it works in light and dark.
- Text in the SVG: short labels only ("Yon", "Add computer", the computer
  name truncated to 18 characters with "…").

## Security

No new data, network, or permission. The computer name is rendered as SVG
text through React (escaped). Turn on uses the existing `set_remote`
command and its existing validation.

## Testing

- `bun run typecheck`, `bun run lint`, `bun test` (existing suites).
- Manual (`bun run tauri dev`): both paths, remote off → Turn on → code,
  Turn on disabled without a relay, light and dark theme, reduced motion
  (System Settings → Accessibility → Display → Reduce motion), Pause/Play,
  keyboard: Tab order and Esc unchanged.

## Out of scope

- Detecting whether the phone already has Yon.
- Animating the "Pair again" flow.
- Localisation of the animation labels.
