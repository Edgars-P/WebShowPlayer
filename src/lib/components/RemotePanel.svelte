<script lang="ts">
  // The host's pairing panel: an overlay showing the on/off switch, the QR a
  // phone scans, the connection status, and the unpair/regenerate control.
  //
  // Contacting a relay is gated behind the switch in here — opening this panel
  // shows the QR but stays offline until the operator turns the remote On.

  import qrcode from 'qrcode-generator';
  import { remoteHost } from '../remote/remoteHost.svelte';

  /** Render a QR for `text` as a self-contained, scalable SVG string. */
  function qrSvg(text: string): string {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }

  let url = $derived(remoteHost.pairUrl);
  let svg = $derived(url ? qrSvg(url) : '');

  let copied = $state(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard access can be denied; the URL is still visible to type.
    }
  }

  let statusLabel = $derived(
    !remoteHost.enabled
      ? 'Off'
      : remoteHost.peerCount > 0
        ? `${remoteHost.peerCount} device${remoteHost.peerCount === 1 ? '' : 's'} connected`
        : 'Waiting for a device…',
  );

  function close() {
    remoteHost.panelOpen = false;
  }

  function regenerate() {
    if (
      remoteHost.peerCount > 0 &&
      !confirm('Regenerate the pairing code? Any connected phone will be disconnected and must re-scan.')
    ) {
      return;
    }
    remoteHost.regenerate();
  }
</script>

{#if remoteHost.panelOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={close}>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="panel" onclick={(e) => e.stopPropagation()}>
      <header>
        <strong>Phone remote</strong>
        <button class="ghost" onclick={close} title="Close">✕</button>
      </header>

      <div class="switch">
        <span class="status" class:live={remoteHost.enabled} class:paired={remoteHost.peerCount > 0}></span>
        <span class="statustext">{statusLabel}</span>
        <button
          class="ghost toggle"
          class:on={remoteHost.enabled}
          onclick={() => remoteHost.toggleEnabled()}
        >
          {remoteHost.enabled ? 'Turn off' : 'Turn on'}
        </button>
      </div>

      {#if remoteHost.enabled}
        <p class="hint">Scan with a phone camera to pair.</p>
        <div class="qr">
          <!-- Self-generated SVG from our own pairing URL; no external input. -->
          {@html svg}
        </div>
        <div class="urlrow">
          <input class="url" readonly value={url} onclick={(e) => e.currentTarget.select()} />
          <button class="ghost" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <div class="footer">
          <button class="ghost danger" onclick={regenerate} title="Invalidate the current code and make a new one">
            Regenerate code
          </button>
        </div>
      {:else}
        <p class="hint off">Off — nothing is broadcast until you turn it on.</p>
      {/if}

      {#if remoteHost.lastError}
        <p class="err">{remoteHost.lastError}</p>
      {/if}

      <p class="note">The phone needs to be online to reach this site. The connection stays private to your paired devices.</p>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .panel {
    width: 360px;
    max-width: 100%;
    max-height: 100%;
    overflow: auto;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .switch {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
  }
  .status {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--muted);
    flex: none;
  }
  .status.live {
    background: var(--warn);
  }
  .status.paired {
    background: var(--ok);
  }
  .statustext {
    flex: 1;
    font-size: 13px;
  }
  .toggle.on {
    border-color: var(--accent);
    color: var(--accent);
  }
  .hint {
    font-size: 12px;
    color: var(--muted);
    margin: 0;
  }
  .hint.off {
    padding: 4px 0;
  }
  .qr {
    background: #fff;
    border-radius: 8px;
    padding: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .qr :global(svg) {
    width: 260px;
    height: 260px;
    max-width: 100%;
    display: block;
  }
  .urlrow {
    display: flex;
    gap: 6px;
  }
  .url {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    font-family: ui-monospace, monospace;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
  }
  .danger {
    color: var(--danger);
    border-color: var(--danger);
  }
  .err {
    color: var(--danger);
    font-size: 12px;
    margin: 0;
  }
  .note {
    font-size: 11px;
    color: var(--muted);
    margin: 0;
    line-height: 1.4;
  }
</style>
