// Applies the saved theme (light | dark | system; light by default) before first paint, so a
// dark-mode user never sees a white flash. An external file, because the CSP forbids inline scripts.
(function () {
  var pref = 'light';
  try {
    pref = localStorage.getItem('aop-theme') || 'light';
  } catch {
    // Storage unavailable (private mode): use the default light theme.
  }
  var dark =
    pref === 'dark' ||
    (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
