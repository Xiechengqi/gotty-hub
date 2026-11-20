import {useRef, type HTMLAttributes} from 'react';
import {FocusScope, useOverlay} from 'react-aria';
import {useDirection} from '@/components/foundations/direction/direction';

/** A modal focus scope for content that must never be moved or remounted.
 * Keep this component mounted when closed. The caller supplies the backdrop
 * and dismiss controls; Escape deliberately remains available to the content.
 */
export function InPlaceModal({isOpen, children, ...props}: HTMLAttributes<HTMLDivElement> & {isOpen: boolean}) {
  const root = useRef<HTMLDivElement>(null);
  const direction = useDirection();
  const {overlayProps} = useOverlay({isOpen, isKeyboardDismissDisabled: true}, root);
  return <div {...props} {...overlayProps} ref={root} dir={direction}
    role={isOpen ? 'dialog' : props.role} aria-modal={isOpen || undefined} data-in-place-modal={isOpen || undefined}>
    <FocusScope contain={isOpen}>{children}</FocusScope>
  </div>;
}
