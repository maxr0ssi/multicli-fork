/** Authenticated application shell. All state comes from the run-scoped API. */
export function renderStudioDocument(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<title>Multi-CLI Studio</title>',
    '<link rel="stylesheet" href="/studio/assets/studio.css">',
    '</head>',
    '<body>',
    '<div id="studio-root"></div>',
    '<noscript>Multi-CLI Studio requires JavaScript to display live workflow state.</noscript>',
    '<script type="module" src="/studio/assets/studio.js"></script>',
    '</body>',
    '</html>',
  ].join('');
}
