// Circular progress drawn around a device. `progress` null = indeterminate.
const R = 46;
const C = 2 * Math.PI * R;

export default function Ring({ progress }: { progress: number | null }) {
  const offset = progress === null ? C * 0.75 : C * (1 - Math.min(1, Math.max(0, progress)));
  return (
    <svg className={`progress-ring${progress === null ? " spinning" : ""}`} viewBox="0 0 100 100" aria-hidden>
      <circle className="ring-track" cx="50" cy="50" r={R} />
      {/* Only the bar spins; the track and the <svg> box stay still. */}
      <g className="ring-spin">
        <circle
          className="ring-bar"
          cx="50"
          cy="50"
          r={R}
          strokeDasharray={C}
          strokeDashoffset={offset}
          transform="rotate(-90 50 50)"
        />
      </g>
    </svg>
  );
}
