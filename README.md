# Web Show Player

## Deployment (Cloudflare Worker + Static Assets)

The site is served by a single Cloudflare Worker (`worker/index.ts`): it serves the
built static app from `dist/` and terminates the phone-remote WebSocket at
`/api/remote/<roomId>`, routing it to a per-room `RemoteRoom` Durable Object that relays
messages between the player and its phones. Config is in `wrangler.jsonc`.

```sh
pnpm build            # vite build → dist/
pnpm deploy           # vite build && wrangler deploy
pnpm cf:dev           # vite build && wrangler dev (serves assets + worker locally)
```

`pnpm dev` (plain Vite) is fine for UI work but does **not** serve `/api/*`, so the phone
remote only works under `wrangler dev` or a real deploy.

### Phone remote setup (the `HOST_KEY` secret)

The remote authenticates the player with a shared secret, `HOST_KEY`, held in two places:

1. **The Worker** — `wrangler secret put HOST_KEY` (production) or a git-ignored
   `.dev.vars` with `HOST_KEY=…` (for `wrangler dev`; see `.dev.vars.example`).
2. **The player** — paste the *same* value into the remote panel's "Host key" field
   (there's a "Generate" button to mint a strong one). It's stored in `localStorage`.

The phone never receives `HOST_KEY`. When the operator turns the remote on, the player
puts a room id + a derived key — `SHA-256(HOST_KEY + ":" + roomId)` — in the QR; the
Worker re-derives and validates it. "Regenerate code" mints a new room id, invalidating
every previously scanned QR.

## Svelte + TS + Vite

This template should help get you started developing with Svelte and TypeScript in Vite.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode).

## Need an official Svelte framework?

Check out [SvelteKit](https://github.com/sveltejs/kit#readme), which is also powered by Vite. Deploy anywhere with its serverless-first approach and adapt to various platforms, with out of the box support for TypeScript, SCSS, and Less, and easily-added support for mdsvex, GraphQL, PostCSS, Tailwind CSS, and more.

## Technical considerations

**Why use this over SvelteKit?**

- It brings its own routing solution which might not be preferable for some users.
- It is first and foremost a framework that just happens to use Vite under the hood, not a Vite app.

This template contains as little as possible to get started with Vite + TypeScript + Svelte, while taking into account the developer experience with regards to HMR and intellisense. It demonstrates capabilities on par with the other `create-vite` templates and is a good starting point for beginners dipping their toes into a Vite + Svelte project.

Should you later need the extended capabilities and extensibility provided by SvelteKit, the template has been structured similarly to SvelteKit so that it is easy to migrate.

**Why `global.d.ts` instead of `compilerOptions.types` inside `jsconfig.json` or `tsconfig.json`?**

Setting `compilerOptions.types` shuts out all other types not explicitly listed in the configuration. Using triple-slash references keeps the default TypeScript setting of accepting type information from the entire workspace, while also adding `svelte` and `vite/client` type information.

**Why include `.vscode/extensions.json`?**

Other templates indirectly recommend extensions via the README, but this file allows VS Code to prompt the user to install the recommended extension upon opening the project.

**Why enable `allowJs` in the TS template?**

While `allowJs: false` would indeed prevent the use of `.js` files in the project, it does not prevent the use of JavaScript syntax in `.svelte` files. In addition, it would force `checkJs: false`, bringing the worst of both worlds: not being able to guarantee the entire codebase is TypeScript, and also having worse typechecking for the existing JavaScript. In addition, there are valid use cases in which a mixed codebase may be relevant.

**Why is HMR not preserving my local component state?**

HMR state preservation comes with a number of gotchas! It has been disabled by default in both `svelte-hmr` and `@sveltejs/vite-plugin-svelte` due to its often surprising behavior. You can read the details [here](https://github.com/rixo/svelte-hmr#svelte-hmr).

If you have state that's important to retain within a component, consider creating an external store which would not be replaced by HMR.

```ts
// store.ts
// An extremely simple external store
import { writable } from 'svelte/store'
export default writable(0)
```
