import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { trello } from './lib/state/trello.svelte'
import { remoteHost } from './lib/remote/remoteHost.svelte'

// Load stored Trello credentials before the first render, so the sidebar comes
// up already populated rather than flashing its setup form.
trello.start()

// Load the remote's stored pairing identity (but stay offline — the remote only
// contacts a relay once the operator switches it on).
remoteHost.start()

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
