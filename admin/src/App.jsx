import { useEffect, useRef } from 'react';
import bodyHtml from './body.html?raw';
import { runLegacyAdmin } from './legacy';

export default function App() {
  const hostRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Render the exact same HTML structure as the original admin/index.html
    host.innerHTML = bodyHtml;

    // Then run the legacy logic (API calls, wiring, charts, etc.)
    runLegacyAdmin();
  }, []);

  return <div ref={hostRef} />;
}

