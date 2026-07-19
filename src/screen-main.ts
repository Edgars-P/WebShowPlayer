import { mount } from 'svelte'
import ScreenPage from './lib/screen/ScreenPage.svelte'

const app = mount(ScreenPage, {
  target: document.getElementById('app')!,
})

export default app
