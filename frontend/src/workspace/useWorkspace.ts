import {useRef, useState} from 'react';
import {api, APIError} from '../api';
import {
  legacyWorkspaceDraft, readCompactOrder, readWorkspaceDraft, rememberCompactOrder, rememberWorkspaceDraft, type LayoutEdit,
} from '../layout';
import {randomId} from '../random';
import {
  applyLayout, displayView, emptyWorkspace, isGroup, migrateWorkspace, navigationUnits, openedUnits, reconcileUnits,
  reorder, selectInstance, tabIds, type LayoutAction, type Unit, type Workspace,
} from './state';

export type WorkspaceSnapshot = {revision: number; writeId: string | null; units: Unit[] | null};
type Session = {
  account: string;
  base: Unit[];
  available: string[];
  revision: number;
  observedRevision: number;
  importId: string;
  edits: LayoutEdit[];
  busy: boolean;
  abort: AbortController;
};

export function useWorkspace(initial: Workspace, onError: (error: unknown) => void) {
  const [workspace, setWorkspace] = useState(initial);
  const current = useRef(workspace);
  const live = useRef<Session | null>(null);
  const report = useRef(onError);
  report.current = onError;

  function show(next: Workspace) {
    const oldOrder = current.current.view.compactOrder;
    current.current = next;
    setWorkspace(next);
    const session = live.current;
    if (session) {
      rememberWorkspaceDraft(session.account, {view: next.view, edits: session.edits});
      const order = next.view.compactOrder;
      if (order && order !== oldOrder) rememberCompactOrder(session.account, order);
    }
  }

  function publish(session: Session, preferred?: string) {
    const base = current.current;
    let units = session.base;
    for (const edit of session.edits) units = applyLayout(units, edit.action) ?? units;
    show({units, view: displayView(base, units, preferred)});
  }

  function adopt(session: Session, snapshot: WorkspaceSnapshot) {
    if (session.edits[0]?.writeId === snapshot.writeId) session.edits.shift();
    session.revision = snapshot.revision;
    if (snapshot.units) session.base = reconcileUnits(snapshot.units, session.available);
    session.observedRevision = Math.max(session.observedRevision, snapshot.revision);
    publish(session);
  }

  async function flush(session: Session) {
    if (session.busy || live.current !== session) return;
    session.busy = true;
    const {signal} = session.abort;
    let conflicts = 0;
    try {
      while (live.current === session) {
        if (session.observedRevision > session.revision) {
          const snapshot = await api<WorkspaceSnapshot>('/me/workspace', undefined, undefined, signal);
          if (live.current !== session) return;
          adopt(session, snapshot);
        }
        const importing = session.revision === 0, edit = session.edits[0];
        if (!importing && !edit) break;
        const units = importing ? session.base : applyLayout(session.base, edit.action);
        if (!units || !importing && units === session.base) {
          if (!units) report.current(Error('workspace_members_changed'));
          session.edits.shift();
          publish(session);
          continue;
        }
        const writeId = importing ? session.importId : edit.writeId;
        try {
          const saved = await api<{revision: number; replayed: boolean}>('/me/workspace',
            {revision: session.revision, writeId, units}, 'PUT', signal);
          if (live.current !== session) return;
          const snapshot = saved.replayed ? await api<WorkspaceSnapshot>('/me/workspace', undefined, undefined, signal) : undefined;
          if (live.current !== session) return;
          if (!importing) session.edits.shift();
          conflicts = 0;
          if (snapshot) {
            adopt(session, snapshot);
          } else {
            session.revision = saved.revision;
            session.base = reconcileUnits(units, session.available);
            publish(session);
          }
        } catch (error) {
          if (live.current !== session) return;
          if (!(error instanceof APIError) || error.status !== 409 || ++conflicts > 3) throw error;
          const snapshot = await api<WorkspaceSnapshot>('/me/workspace', undefined, undefined, signal);
          if (live.current !== session) return;
          if (error.code === 'workspace_members_changed') {
            const rows = await api<{id: string}[]>('/instances', undefined, undefined, signal);
            if (live.current !== session) return;
            session.available = rows.map(row => row.id);
            session.base = reconcileUnits(session.base, session.available);
          }
          adopt(session, snapshot);
        }
      }
    } catch (error) {
      if (live.current === session) report.current(error);
    } finally {
      session.busy = false;
    }
  }

  function restore(account: string, prefs: Record<string, unknown>, snapshot: WorkspaceSnapshot, available: string[], preferred: string) {
    live.current?.abort.abort();
    const draft = readWorkspaceDraft(account);
    const legacy = migrateWorkspace(prefs, available, preferred, snapshot.units === null ? legacyWorkspaceDraft(account) : undefined);
    const base = snapshot.units === null ? legacy.units : reconcileUnits(snapshot.units, available);
    const session: Session = {
      account, base, available, revision: snapshot.revision, observedRevision: snapshot.revision,
      importId: randomId(), edits: draft?.edits ?? [], busy: false, abort: new AbortController(),
    };
    if (session.edits[0]?.writeId === snapshot.writeId) session.edits.shift();
    live.current = session;
    const view = draft?.view ?? legacy.view;
    current.current = {units: base, view: {...view, compactOrder: readCompactOrder(account) ?? view.compactOrder}};
    publish(session, preferred);
    void flush(session);
    return current.current.view.active;
  }

  function reset() {
    live.current?.abort.abort();
    live.current = null;
    show(emptyWorkspace());
  }

  function reconcile(available: string[]) {
    const session = live.current;
    if (!session) {
      const before = current.current;
      const units = reconcileUnits(before.units, available);
      if (units !== before.units) show({units, view: displayView(before, units)});
      return;
    }
    session.available = available;
    const next = reconcileUnits(session.base, available);
    if (next === session.base) return;
    session.base = next;
    publish(session);
    void flush(session);
  }

  function edit(action: LayoutAction, selected?: string) {
    const before = current.current;
    const units = applyLayout(before.units, action);
    if (!units || units === before.units) return false;
    const session = live.current;
    if (session) session.edits.push({writeId: randomId(), action});
    const next = {units, view: displayView(before, units)};
    show(selected ? selectInstance(next, selected, true) : next);
    if (session) void flush(session);
    return true;
  }

  function select(id: string, wide: boolean, reopen = false) {
    if (reopen && edit({type: 'open', id}, id)) return;
    const next = selectInstance(current.current, id, wide);
    if (next !== current.current) show(next);
  }

  function reorderWide(id: string, target: string) {
    if (id === target) return;
    const units = current.current.units;
    const after = units.findIndex(unit => unit.id === id) < units.findIndex(unit => unit.id === target);
    edit({type: 'reorder', id, target, after});
  }

  function reorderCompact(id: string, target: string) {
    const before = current.current;
    const ids = navigationUnits(before, false).map(unit => unit.id);
    const compactOrder = reorder(ids, ids.indexOf(id), ids.indexOf(target));
    if (compactOrder !== ids) show({...before, view: {...before.view, compactOrder}});
  }

  function initializeCompactOrder() {
    const before = current.current;
    if (before.view.compactOrder !== null) return;
    const compactOrder = openedUnits(before.units).flatMap(tabIds);
    if (compactOrder.length) show({...before, view: {...before.view, compactOrder}});
  }

  function pageMode(group: string, paged: boolean) {
    const before = current.current;
    if (!before.units.some(unit => unit.id === group && isGroup(unit))) return;
    const groups = before.view.pagedGroups;
    const pagedGroups = paged ? [...new Set([...groups, group])] : groups.filter(id => id !== group);
    show({...before, view: {...before.view, pagedGroups}});
  }

  function sync(revision?: number) {
    const session = live.current;
    if (!session) return;
    if (revision !== undefined) session.observedRevision = Math.max(session.observedRevision, revision);
    void flush(session);
  }

  return {workspace, current, restore, reset, reconcile, edit, select, reorderWide, reorderCompact, initializeCompactOrder, pageMode, sync};
}
