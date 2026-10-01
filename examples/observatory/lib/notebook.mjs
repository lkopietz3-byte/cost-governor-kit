import { validateSettings } from './session.mjs';

export const NOTEBOOK_KEY = 'cost-governor-kit.threshold.notebook.v1';
export const NOTEBOOK_LIMIT = 12;
const SCHEMA = 'threshold-notebook-v1';
const MAX_TEXT = 24_000;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Saved notebook has an unsupported shape.');
}
function title(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 60 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error('Give this setup a name of 1–60 characters without hidden control characters.');
  return value.trim();
}
export function parseNotebook(raw) {
  if (raw === null) return freeze({ schema: SCHEMA, revision: 0, setups: [] });
  if (typeof raw !== 'string' || raw.length > MAX_TEXT) throw new Error('Saved notebook exceeds the supported size.');
  const value = JSON.parse(raw);
  shape(value, ['schema', 'revision', 'setups']);
  if (value.schema !== SCHEMA) throw new Error('Saved notebook uses an unsupported version.');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Saved notebook has an invalid revision.');
  if (!Array.isArray(value.setups) || value.setups.length > NOTEBOOK_LIMIT) throw new Error('Saved notebook exceeds the 12-setup limit.');
  const ids = new Set();
  const setups = value.setups.map(row => {
    shape(row, ['id', 'name', 'savedAt', 'settings']);
    if (typeof row.id !== 'string' || !ID.test(row.id) || ids.has(row.id)) throw new Error('Saved notebook contains an invalid or repeated setup ID.');
    ids.add(row.id);
    if (typeof row.savedAt !== 'string' || !Number.isFinite(Date.parse(row.savedAt)) || new Date(row.savedAt).toISOString() !== row.savedAt) throw new Error('Saved setup has an invalid date.');
    return { id: row.id, name: title(row.name), savedAt: row.savedAt, settings: validateSettings(row.settings) };
  });
  return freeze({ schema: SCHEMA, revision: value.revision, setups });
}

/** Only conditions are saved. Journals, outcomes and proof never enter browser storage. */
export function createNotebook({ getStorage, withLock }) {
  function read() {
    let raw = null;
    try {
      raw = getStorage().getItem(NOTEBOOK_KEY);
      const document = parseNotebook(raw);
      return { status: 'ready', raw, document, writable: typeof withLock === 'function', message: typeof withLock === 'function' ? '' : 'Saving needs browser tab coordination. Existing setups can still be opened; export your run to keep its journal.' };
    } catch (error) {
      return { status: raw === null ? 'unavailable' : 'invalid', raw, document: null, writable: false,
        message: raw === null ? 'Browser storage is unavailable. Your experiment still works; export its journal to keep it.' : `Saved notebook needs repair: ${error.message} Its original data is preserved; download a backup before repairing browser storage.` };
    }
  }
  async function change(update) {
    if (typeof withLock !== 'function') throw new Error('Not saved: this browser cannot coordinate notebook writes. Export the run instead.');
    return withLock(() => {
      const state = read();
      if (state.status !== 'ready') throw new Error(`Not saved. ${state.message}`);
      const next = update(state.document);
      const serialized = JSON.stringify({ ...next, revision: state.document.revision + 1 });
      parseNotebook(serialized);
      const storage = getStorage();
      // Locks coordinate this app's tabs. Rereads also detect edits by other code.
      if (storage.getItem(NOTEBOOK_KEY) !== state.raw) throw new Error('Notebook changed before saving. Reload the notebook and try again.');
      try { storage.setItem(NOTEBOOK_KEY, serialized); }
      catch { throw new Error('Not saved: browser storage rejected the write. Existing setups and the current run are preserved.'); }
      if (storage.getItem(NOTEBOOK_KEY) !== serialized) throw new Error('The write could not be verified. Reload the notebook before retrying.');
      return read();
    });
  }
  return Object.freeze({
    read,
    save(settings, name) {
      const validated = validateSettings(settings);
      const validatedName = title(name);
      return change(document => {
        if (document.setups.length >= NOTEBOOK_LIMIT) throw new Error('Not saved: the notebook has 12 setups. Export a backup and remove a setup before saving another.');
        return { ...document, setups: [...document.setups, { id: globalThis.crypto.randomUUID(), name: validatedName, savedAt: new Date().toISOString(), settings: validated }] };
      });
    },
    remove(id, expectedRecord) {
      return change(document => {
        const row = document.setups.find(item => item.id === id);
        if (!row || JSON.stringify(row) !== JSON.stringify(expectedRecord)) throw new Error('This setup changed in another tab. Reload the notebook before removing it.');
        return { ...document, setups: document.setups.filter(item => item.id !== id) };
      });
    },
  });
}
