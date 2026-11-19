import {useState} from 'react';
import {Button} from '@/components/base/buttons/button';
import {Checkbox} from '@/components/base/checkbox/checkbox';
import {Input} from '@/components/base/input/input';
import {Modal, ModalBody, ModalFooter, ModalHeader} from '@/components/base/modal/modal';
import {translate, type Locale} from '../i18n';
import type {SplitGroup} from './state';
import type {PaneInstance} from './WorkspaceControls';

export type SplitRequest = {kind: 'create' | 'join'; id: string};
export function SplitDialog({request, instances, candidates, groups, locale, onClose, onCreate, onJoin}: {
  request: SplitRequest; instances: Map<string, PaneInstance>; candidates: PaneInstance[]; groups: SplitGroup[]; locale: Locale;
  onClose: () => void; onCreate: (members: string[]) => boolean; onJoin: (group: string) => boolean;
}) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const create = request.kind === 'create';
  const source = instances.get(request.id);
  const term = search.trim().toLocaleLowerCase();
  const filtered = (text: string) => text.toLocaleLowerCase().includes(term);
  const available = new Set(candidates.map(candidate => candidate.id));
  const chosen = selection.filter(id => available.has(id));
  const valid = !!source && available.has(request.id);
  const candidateRows = candidates.filter(candidate => candidate.id !== request.id && filtered(candidate.label + ' ' + candidate.id));
  const groupRows = groups.map(group => {
    const labels = group.members.map(id => instances.get(id)?.label ?? id);
    return {id: group.id, name: labels[0] + ' · ' + labels.length, labels};
  }).filter(group => filtered(group.labels.join(' ')));

  return <Modal isOpen onOpenChange={open => {if (!open) onClose();}} size="md" className="split-dialog">
    <ModalHeader title={t(create ? 'newSplit' : 'joinSplit')}
      description={source && (create ? t('splitAnchor') + ' · ' + source.label : source.label)} closeLabel={t('cancel')}/>
    <ModalBody>
      <Input autoFocus label={t(create ? 'findInstance' : 'findSplit')} value={search} onChange={setSearch}/>
      {!valid || error || chosen.length !== selection.length ? <p className="text-body-2-regular text-text-error-primary mt-2" role="alert">{t('splitChanged')}</p> : null}
      <ul className="split-picker">
        {create ? candidateRows.map(instance => <li key={instance.id}>
          <Checkbox className="split-choice" isSelected={chosen.includes(instance.id)} onChange={checked => {
            setSelection(current => checked ? [...current.filter(id => available.has(id)), instance.id] : current.filter(id => id !== instance.id && available.has(id)));
            setError(false);
          }}><span className="split-option-label"><bdi>{instance.label}</bdi>{!instance.online && <span>{t('offline')}</span>}{instance.online && !instance.writable && <span>{t('readOnly')}</span>}</span></Checkbox>
        </li>) : groupRows.map(group => <li key={group.id}>
          <Button variant="ghost" className="split-group-choice" disabled={!valid} onClick={() => {
            if (!onJoin(group.id)) setError(true);
          }}>
            <span className="split-group-summary"><bdi>{group.name}</bdi>
              <span className="text-caption-1-regular text-text-secondary">{group.labels.slice(0, 5).join(' · ')}{group.labels.length > 5 && ' …'}</span>
            </span>
          </Button>
        </li>)}
      </ul>
      {!(create ? candidateRows.length : groupRows.length) && <p className="text-body-2-regular text-text-secondary mt-2">{t('noSplitMatches')}</p>}
    </ModalBody>
    {create && <ModalFooter><Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
      <Button disabled={!valid || !chosen.length} onClick={() => {if (!onCreate(chosen)) setError(true);}}>
        {t('newSplit')}{!!chosen.length && ' · ' + (chosen.length + 1)}
      </Button></ModalFooter>}
  </Modal>;
}
