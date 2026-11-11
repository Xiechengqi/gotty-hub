import {useState, type ReactNode} from 'react';
import {RiArrowDownSLine, RiCloseLine, RiAddLine} from '@remixicon/react';
import {Button} from '@/components/base/buttons/button';
import {Input} from '@/components/base/input/input';
import {Drawer, DrawerHeader, DrawerBody} from '@/components/base/drawer/drawer';
import {translate, type Locale} from '../i18n';

type Session = {id: string; name: string; online: boolean; icon: ReactNode};
export function SessionSwitcher({sessions, active, locale, onSelect, onClose, onBrowse}: {
  sessions: Session[]; active: string; locale: Locale;
  onSelect: (id: string) => void; onClose: (id: string) => void; onBrowse: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const current = sessions.find(session => session.id === active);
  const shown = sessions.filter(session => session.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="mobile-session-switcher">
    <Button className="quiet-button session-switcher-trigger" variant="ghost" trailingIcon={RiArrowDownSLine} aria-label={`${t('switchInstance')}: ${current?.name ?? t('selectTerminal')} (${sessions.length})`} aria-expanded={open} aria-haspopup="dialog" onClick={() => {setQuery(''); setOpen(true);}}>
      <span className="session-label">{current?.icon}<span className="session-name">{current?.name ?? t('selectTerminal')}</span></span><span className="nav-count">{sessions.length}</span>
    </Button>
    <Drawer isOpen={open} onOpenChange={setOpen} placement="bottom" aria-label={t('opened')}>
      <DrawerHeader title={`${t('opened')} (${sessions.length})`} closeLabel={t('close')}/>
      <div className="px-6 pb-4"><Input aria-label={t('search')} placeholder={t('search')} value={query} onChange={setQuery}/></div>
      <DrawerBody><ul className="session-switcher-list">
        {shown.map(session => <li key={session.id} className="session-switcher-row">
          <Button variant="ghost" className="quiet-button session-switcher-item" aria-current={session.id === active ? 'page' : undefined} ref={element => {if (element && open && session.id === active) element.scrollIntoView?.({block: 'nearest'});}} onClick={() => {onSelect(session.id); setOpen(false);}}><span className="session-label">{session.icon}<span className="session-name">{session.name}</span></span><span className="text-caption-1-regular text-text-tertiary">{t(session.online ? 'online' : 'offline')}</span></Button>
          <Button variant="ghost" className="quiet-button" iconOnly leadingIcon={RiCloseLine} aria-label={`${t('closeTab')} ${session.name}`} onClick={() => onClose(session.id)}/>
        </li>)}
      </ul>{!shown.length && <p className="py-4 text-body-regular text-text-tertiary">{t('noResults')}</p>}</DrawerBody>
      <div className="px-6 py-4"><Button variant="secondary" leadingIcon={RiAddLine} onClick={() => {setOpen(false); onBrowse();}}>{t('all')}</Button></div>
    </Drawer>
  </div>;
}
