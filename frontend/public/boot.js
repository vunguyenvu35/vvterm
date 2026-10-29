// Runs before the page paints: applies the last appearance the app used, so a light window does not open dark.
try {
  var a = localStorage.getItem('vvterm.appearance')
  if (a === 'light' || a === 'dark') document.documentElement.setAttribute('data-theme', a)
} catch (e) { /* default: dark */ }
