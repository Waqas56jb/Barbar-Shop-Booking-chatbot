import { Chart, registerables } from 'chart.js';
import legacyCode from './legacy.raw.js?raw';

let _ran = false;

export function runLegacyAdmin() {
  if (_ran) return;
  _ran = true;

  // Legacy dashboard script expects global Chart.js (UMD from CDN previously)
  Chart.register(...registerables);
  window.Chart = Chart;

  // Execute the extracted inline scripts in the global scope so they can
  // attach event listeners and access DOM by id/class exactly as before.
  // eslint-disable-next-line no-new-func
  const fn = new Function(legacyCode);
  fn();

  // In the original HTML, the script was parsed before the DOM was ready and
  // relied on DOMContentLoaded. In React/Vite, we execute after mount; we
  // re-dispatch the event so the same wiring runs.
  try {
    document.dispatchEvent(new Event('DOMContentLoaded'));
  } catch {
    // ignore
  }
}

