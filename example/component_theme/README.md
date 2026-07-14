# Shared Arcane theme example

This example composes the shared `theme-switcher` and `theme-editor` components with `ThemeManager`.

- `theme-switcher` provides Auto, Light, Dark, and saved Skin modes.
- `theme-editor` emits `theme-preview`, `theme-save`, and `theme-reset` events.
- `ThemeManager` validates, persists, applies, and shares the current theme.
- `Theme` accepts only the named Arcane token set and validated RGB or RGBA colors; hexadecimal color-picker values are normalized to RGB and arbitrary CSS is rejected.
- `arcane/css/theme.css` supplies the canonical Arcane Light and Arcane Dark palettes and follows the device preference in Auto mode.

Serve the repository root over HTTP and open `example/component_theme/index.html`.
