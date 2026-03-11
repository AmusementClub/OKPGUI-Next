# OKPGUI-Next

OKPGUI-Next is a Tauri desktop application for managing OKP publishing workflows with a modern React frontend and a Rust backend.

It is intended to replace the older OKPGUI client while keeping the same core workflow: manage identities, capture site cookies, prepare publish content, inspect torrent contents, and publish through OKP.Core.

## Stack

- Frontend: React 19, TypeScript, Vite
- Desktop shell: Tauri 2
- Backend: Rust

## Main Features

- Template-based publish form
- Identity and cookie management for supported sites
- Torrent file parsing and file tree preview
- Markdown preview for descriptions
- Publish execution with live console output

## Development

Install dependencies:

```bash
pnpm install
```

Run the frontend in development mode:

```bash
pnpm dev
```

Run the Tauri desktop app:

```bash
pnpm tauri dev
```

Build the frontend:

```bash
pnpm build
```

## Notes

- The frontend lives in `src/`.
- The Tauri backend lives in `src-tauri/`.
- Some publishing and login flows depend on local browser and OKP.Core availability.
