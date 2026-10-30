// Applies the saved theme (light | dark | system) before first paint, so a dark-mode user never
// sees a white flash. An external file, because the CSP forbids inline scripts.
(function () {
  var pref = 'system';
  try {
    pref = localStorage.getItem('aop-theme') || 'system';
  } catch {
    // Storage unavailable (private mode): follow the system.
  }
  var dark =
    pref === 'dark' ||
    (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
