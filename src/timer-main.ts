import { mount } from 'svelte'
import TimerPage from './lib/timer/TimerPage.svelte'

const app = mount(TimerPage, {
  target: document.getElementById('app')!,
})

export default app
