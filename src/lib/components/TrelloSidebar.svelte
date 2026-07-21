<script lang="ts">
  import { trello, authorizeUrl, POLL_MS, type TrelloSettings } from '../state/trello.svelte';
  import { isDone, labelColor, labelTitle } from '../trello/client';
  import IconSettings from '~icons/bi/gear-fill';
  import IconCollapse from '~icons/bi/chevron-right';
  import IconRefresh from '~icons/bi/arrow-clockwise';
  import IconDone from '~icons/bi/check-lg';

  let list = $derived(trello.list);

  // Ticks once a second purely so the "updated Ns ago" readout stays honest.
  let now = $state(Date.now());

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  let age = $derived(
    trello.lastUpdated === 0 ? '' : `${Math.max(0, Math.round((now - trello.lastUpdated) / 1000))}s ago`,
  );

  // Draft copy of the settings, so typing doesn't restart the poll every keystroke.
  let draft = $state<TrelloSettings>({ board: '', key: '', token: '', enabled: true });

  function openSettings() {
    draft = { ...trello.settings, enabled: true };
    trello.settingsOpen = true;
  }

  function save() {
    trello.saveSettings(draft);
  }
</script>

<svelte:document onvisibilitychange={() => trello.handleVisibility(document.hidden)} />

{#if trello.settings.enabled}
  {#if trello.collapsed}
    <button class="rail" title="Show Trello list" onclick={() => (trello.collapsed = false)}>
      <span class="railtext">{list?.name ?? 'Trello'}</span>
    </button>
  {:else}
    <aside class="sidebar">
      <header class="head">
        <span class="title" title={list?.name ?? ''}>{list?.name ?? 'Trello'}</span>
        {#if list}<span class="count">{list.cards.length}</span>{/if}
        <button class="ghost icon" title="Settings" onclick={openSettings}><IconSettings /></button>
        <button class="ghost icon" title="Hide sidebar" onclick={() => (trello.collapsed = true)}><IconCollapse /></button>
      </header>

      {#if trello.settingsOpen}
        <div class="settings">
          <label for="tr-board">Board URL or id</label>
          <input id="tr-board" bind:value={draft.board} placeholder="https://trello.com/b/…" />

          <label for="tr-key">API key</label>
          <input id="tr-key" bind:value={draft.key} placeholder="from trello.com/power-ups/admin" />

          <label for="tr-token">Token</label>
          <input id="tr-token" type="password" bind:value={draft.token} placeholder="authorised token" />

          {#if draft.key.trim()}
            <a class="authlink" href={authorizeUrl(draft.key.trim())} target="_blank" rel="noreferrer">
              Authorise this key to get a token →
            </a>
          {:else}
            <span class="hint">Get an API key at trello.com/power-ups/admin, then authorise it here.</span>
          {/if}

          <div class="actions">
            <button class="primary" onclick={save} disabled={!draft.board.trim() || !draft.key.trim() || !draft.token.trim()}>
              Save
            </button>
            {#if trello.configured}
              <button class="ghost" onclick={() => (trello.settingsOpen = false)}>Cancel</button>
            {/if}
            <button class="ghost danger" onclick={() => trello.clearSettings()}>Forget</button>
          </div>
          <span class="hint">Read-only. Key and token are stored in this browser only.</span>
        </div>
      {:else}
        {#if trello.error}
          <div class="err">{trello.error}</div>
        {/if}

        <div class="cards">
          {#each list?.cards ?? [] as card (card.id)}
            {@const done = isDone(card)}
            <article class="card" class:done>
              {#if card.labels.length > 0}
                <div class="labels">
                  {#each card.labels as label (label.id)}
                    <span class="label" style:background={labelColor(label.color)} title={labelTitle(label)}></span>
                  {/each}
                </div>
              {/if}
              <div class="name">
                {#if done}<span class="tick" title="Marked complete"><IconDone /></span>{/if}{card.name}
              </div>
            </article>
          {:else}
            {#if !trello.error}
              <div class="empty">{trello.lastUpdated ? 'No cards in this list.' : 'Loading…'}</div>
            {/if}
          {/each}
        </div>

        <footer class="foot">
          <span class="age" class:stale={trello.lastUpdated > 0 && now - trello.lastUpdated > POLL_MS * 3}>
            {trello.loading ? 'refreshing…' : age}
          </span>
          <button class="ghost icon" title="Refresh now" onclick={() => trello.refresh()}><IconRefresh /></button>
        </footer>
      {/if}
    </aside>
  {/if}
{/if}

<style>
  .sidebar {
    width: 300px;
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--panel);
    border-left: 1px solid var(--border);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
  }
  .title {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .icon {
    padding: 2px 7px;
    line-height: 1.2;
  }

  /* Collapsed state: a thin vertical strip that gives the width back. */
  .rail {
    flex: none;
    width: 28px;
    background: var(--panel);
    border: none;
    border-left: 1px solid var(--border);
    border-radius: 0;
    color: var(--muted);
    padding: 8px 0;
  }
  .railtext {
    writing-mode: vertical-rl;
    font-size: 12px;
  }

  .cards {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .card {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 7px 9px;
  }
  /* Cards whose due date is ticked off recede, but stay readable. */
  .card.done {
    opacity: 0.5;
  }
  .card.done .name {
    text-decoration: line-through;
  }

  /* Trello's label bars: colour only, name on hover, as the board shows them. */
  .labels {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
  }
  .label {
    width: 40px;
    height: 8px;
    border-radius: 4px;
  }

  .name {
    font-size: 13px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .tick {
    color: var(--ok);
    margin-right: 5px;
    /* Kept out of the strikethrough that crosses the name itself. */
    display: inline-block;
    text-decoration: none;
  }

  .empty {
    color: var(--muted);
    font-size: 12px;
    padding: 8px 2px;
  }
  .err {
    background: #3a1c1c;
    color: #ffd9d9;
    font-size: 12px;
    padding: 6px 10px;
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 11px;
  }
  .age {
    flex: 1;
    font-variant-numeric: tabular-nums;
  }
  /* Several polls missed in a row — the list on screen may be behind the board. */
  .age.stale {
    color: var(--warn);
  }

  .settings {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px;
    overflow-y: auto;
  }
  .settings input {
    width: 100%;
  }
  .settings label {
    margin-top: 4px;
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: 10px;
  }
  .hint {
    color: var(--muted);
    font-size: 11px;
    margin-top: 6px;
    line-height: 1.4;
  }
  .authlink {
    color: var(--accent);
    font-size: 11px;
    margin-top: 6px;
  }
</style>
