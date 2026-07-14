# Directory picker component

`arcane/components/directory-picker.html` presents a read-only path display and an accessible **Choose folder** button. It uses `arcane/modules/DirectoryPicker.js` to request a native operating-system directory selector through `Arcane.filesystem.selectDirectory(options)`.

The component does not enumerate the selected folder, upload files, persist the path, or fall back to a browser file input. Open the example through an Arcane OS build that declares the native filesystem-selection capability.

## Public contract

- `configure({label, help, buttonLabel, placeholder, title, value, disabled, picker})` configures neutral labels, initial state, and an optional injected picker adapter.
- `value` gets or sets the displayed path. The display remains read-only.
- `disabled` gets or sets whether the selector can be opened.
- `focus()` moves keyboard focus to the **Choose folder** button.
- `select()` opens the provider-owned selector and resolves to `{cancelled, path}`, or `null` when disabled or already opening.

Events bubble and cross the component boundary:

- `directory-picker-ready`
- `directory-picker-change` with `{path, previousPath, source: 'picker'}`
- `directory-picker-cancel` with `{path}`; the existing value is preserved
- `directory-picker-error` with `{error, message}`

The component loads `theme.css`, then `primitives.css`, then its token-based component styles. The example loads `ThemeBootstrap.js` so the saved Arcane appearance is applied.
