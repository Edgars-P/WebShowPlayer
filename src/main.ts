import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { trello } from './lib/state/trello.svelte'

// Load stored Trello credentials before the first render, so the sidebar comes
// up already populated rather than flashing its setup form.
trello.start()

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
