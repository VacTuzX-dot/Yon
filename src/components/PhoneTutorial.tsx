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
  // WHY: 14 chars leaves room for the green check on the last add scene.
  const name = shortName(computer, 14);
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

/** QR-looking square (not a real code): three finder corners + fixed modules. */
function FakeQr({ x, y, size }: { x: number; y: number; size: number }) {
  const m = size / 21;
  let d = "";
  for (let r = 0; r < 21; r++) {
    for (let c = 0; c < 21; c++) {
      const finder = (r < 8 && c < 8) || (r < 8 && c > 12) || (r > 12 && c < 8);
      if (!finder && (r * 7 + c * 13 + r * c) % 5 < 2) d += `M${x + c * m} ${y + r * m}h${m}v${m}h${-m}z`;
    }
  }
  const corner = (fc: number, fr: number) => (
    <g key={`${fc}-${fr}`}>
      <rect x={x + fc * m} y={y + fr * m} width={7 * m} height={7 * m} fill="#000" />
      <rect x={x + (fc + 1) * m} y={y + (fr + 1) * m} width={5 * m} height={5 * m} fill="#fff" />
      <rect x={x + (fc + 2) * m} y={y + (fr + 2) * m} width={3 * m} height={3 * m} fill="#000" />
    </g>
  );
  return (
    <g>
      <rect x={x - 2} y={y - 2} width={size + 4} height={size + 4} fill="#fff" />
      <path d={d} fill="#000" />
      {corner(0, 0)}
      {corner(14, 0)}
      {corner(0, 14)}
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
