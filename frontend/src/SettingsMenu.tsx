import {useState} from 'react';
import {RiDashboard3Line, RiLockPasswordLine, RiLogoutBoxRLine, RiSettings3Line, RiTerminalBoxLine} from '@remixicon/react';
import {Dropdown, DropdownItem, DropdownPopover, DropdownTrigger, DropdownDivider} from '@/components/base/dropdown/dropdown';

export type SettingsAction = 'terminal' | 'console' | 'password' | 'logout';
type Labels = {settings: string; terminalSettings: string; console: string; password: string; logout: string};

// Top-bar settings entry: each item opens its own dialog in the parent.
export function SettingsMenu({labels, admin, onSelect, onOpenChange, extras = [], accountName}: {onOpenChange?: (open: boolean) => void; extras?: {label: string; icon: typeof RiSettings3Line; onSelect: () => void}[]; accountName?: string; labels: Labels; admin: boolean; onSelect: (action: SettingsAction) => void}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (value: boolean) => {setOpenState(value); onOpenChange?.(value);};
  const items: [SettingsAction, string, typeof RiSettings3Line][] = [
    ['terminal', labels.terminalSettings, RiTerminalBoxLine],
    ...(admin ? [['console', labels.console, RiDashboard3Line] as [SettingsAction, string, typeof RiSettings3Line]] : []),
    ['password', labels.password, RiLockPasswordLine],
    ['logout', labels.logout, RiLogoutBoxRLine],
  ];
  return <Dropdown isOpen={open} onOpenChange={setOpen}>
    <DropdownTrigger className="quiet-button settings-trigger" aria-label={labels.settings}><RiSettings3Line aria-hidden="true"/><span className="settings-label text-body-medium">{labels.settings}</span></DropdownTrigger>
    <DropdownPopover aria-label={labels.settings} placement="bottom end" className="w-[200px]">
      {accountName && <div className="px-2 text-body-2-semibold">{accountName}</div>}
      {extras.map(({label, icon: Icon, onSelect}) => <DropdownItem key={label} onSelect={() => {setOpen(false); onSelect();}}><Icon className="size-4" aria-hidden="true"/>{label}</DropdownItem>)}
      {!!extras.length && <DropdownDivider/>}
      {items.map(([action, label, Icon]) => <DropdownItem key={action} className="settings-item text-body-medium" onSelect={() => {setOpen(false); onSelect(action);}}>
        <Icon className="size-4 text-foreground-icon-secondary" aria-hidden="true"/>{label}
      </DropdownItem>)}
    </DropdownPopover>
  </Dropdown>;
}
