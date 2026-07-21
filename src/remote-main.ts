import { mount } from 'svelte'
import './app.css'
import RemotePage from './lib/remote/RemotePage.svelte'

const app = mount(RemotePage, {
  target: document.getElementById('app')!,
})

export default app
