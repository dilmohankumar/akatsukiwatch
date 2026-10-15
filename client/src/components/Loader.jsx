// Scratchy sketch Sharingan loader, black ink only: a wobbly ring, three tomoe spinning around the pupil.
// The wobble "boils" like a flip-book; ink follows the theme text colour so it shows in dark mode too.
export default function Loader({ label = 'Loading…' }) {
  return (
    <div className="eye-loader" role="status" aria-label={label}>
      <svg viewBox="78 28 144 144" className="eye" aria-hidden>
        <defs>
          <filter id="eye-rough" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="3" seed="4" result="n">
              <animate attributeName="seed" values="4;9;15;6;12;2" dur="0.7s" calcMode="discrete" repeatCount="indefinite" />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="n" scale="6" />
          </filter>
          <g id="eye-tomoe">
            <circle cx="0" cy="-48" r="10.5" fill="currentColor" />
            <path d="M 8 -56 A 57 57 0 0 1 54 -20 A 45 45 0 0 0 6 -46 Z" fill="currentColor" />
          </g>
        </defs>
        <g filter="url(#eye-rough)" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text)' }}>
          <circle cx="150" cy="100" r="48" fill="none" stroke="currentColor" strokeWidth="2.2" />
          <circle cx="151" cy="99" r="49" fill="none" stroke="currentColor" strokeWidth="1" strokeOpacity=".6" />
          <g className="eye-spin">
            <g transform="translate(150 100)">
              <use href="#eye-tomoe" />
              <use href="#eye-tomoe" transform="rotate(120)" />
              <use href="#eye-tomoe" transform="rotate(240)" />
            </g>
          </g>
          <circle cx="150" cy="100" r="13" fill="currentColor" />
        </g>
      </svg>
    </div>
  );
}
