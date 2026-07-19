// Naming rules for user-typed cue file names.

import { describe, expect, it } from 'vitest';
import { cueFileNameError, normalizeCueFileName, saveNameFor } from './projectFs';

describe('normalizeCueFileName', () => {
  it('appends .wsp when no save-able extension is given', () => {
    expect(normalizeCueFileName('act one')).toBe('act one.wsp');
    expect(normalizeCueFileName('show')).toBe('show.wsp');
  });

  it('leaves an existing save-able extension alone', () => {
    expect(normalizeCueFileName('cues.wsp')).toBe('cues.wsp');
    expect(normalizeCueFileName('notes.json')).toBe('notes.json');
    expect(normalizeCueFileName('CUES.WSP')).toBe('CUES.WSP');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeCueFileName('  act two  ')).toBe('act two.wsp');
  });

  it('does not treat an unrelated dot as an extension', () => {
    expect(normalizeCueFileName('act 1.2')).toBe('act 1.2.wsp');
  });

  it('returns empty for blank input', () => {
    expect(normalizeCueFileName('   ')).toBe('');
  });
});

describe('cueFileNameError', () => {
  it('accepts ordinary names, including spaces and hyphens', () => {
    for (const name of ['cues', 'cues.wsp', 'act one', 'act-one', 'Act_2 (final).wsp', 'notes.json']) {
      expect(cueFileNameError(name), name).toBeNull();
    }
  });

  it('rejects blank names', () => {
    expect(cueFileNameError('')).toBeTruthy();
    expect(cueFileNameError('   ')).toBeTruthy();
    expect(cueFileNameError('..')).toBeTruthy();
  });

  it('rejects path separators — cue files live in the folder root', () => {
    expect(cueFileNameError('sub/cues.wsp')).toBeTruthy();
    expect(cueFileNameError('sub\\cues.wsp')).toBeTruthy();
  });

  it('rejects characters the filesystem will not take', () => {
    for (const name of ['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b']) {
      expect(cueFileNameError(name), name).toBeTruthy();
    }
    // Control characters are rejected too (built via char codes so the test
    // source stays free of invisible bytes).
    expect(cueFileNameError(`a${String.fromCharCode(1)}b`)).toBeTruthy();
    expect(cueFileNameError(`a${String.fromCharCode(31)}b`)).toBeTruthy();
    expect(cueFileNameError('tab\there')).toBeTruthy();
  });

  it('rejects .lsp, which is import-only', () => {
    // Opening a .lsp is fine — it converts on load — but saving one is not.
    expect(cueFileNameError('old.lsp')).toMatch(/import-only/);
    expect(saveNameFor('old.lsp')).toBe('old.wsp');
  });

  it('rejects names that are too long', () => {
    expect(cueFileNameError('x'.repeat(300))).toBeTruthy();
  });
});
