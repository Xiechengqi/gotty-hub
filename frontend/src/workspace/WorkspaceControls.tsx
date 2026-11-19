import type {ReactNode} from 'react';
import {RiArrowLeftSLine, RiArrowRightSLine} from '@remixicon/react';
import {Button} from '@/components/base/buttons/button';
import {translate, type Locale} from '../i18n';

export type PaneInstance = {id: string; name: string; label: string; online: boolean; writable: boolean; owner: boolean; icon: ReactNode};

export function WorkspacePages({page, pages, onChange, locale}: {
  page: number; pages: number; onChange: (page: number) => void; locale: Locale;
}) {
  return <div className="workspace-pages" role="group" aria-label={translate(locale, 'splitPages')}>
    <Button variant="ghost" size="small" iconOnly leadingIcon={RiArrowLeftSLine} aria-label={translate(locale, 'previousPage')}
      disabled={page === 0} onClick={() => onChange(page - 1)}/>
    <span className="text-caption-1-semibold" aria-live="polite">{page + 1} / {pages}</span>
    <Button variant="ghost" size="small" iconOnly leadingIcon={RiArrowRightSLine} aria-label={translate(locale, 'nextPage')}
      disabled={page === pages - 1} onClick={() => onChange(page + 1)}/>
  </div>;
}
