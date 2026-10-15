import { createContext, useContext } from 'react';

// Pages with tabs (Cloudflare) put the top-bar controls on the tab row, at its right end.
// slots = { filter: Element|null, rest: Element|null }; setSlots is called by the page.
export const ControlsSlot = createContext({ slots: { filter: null, rest: null }, setSlots: () => {} });
export const useControlsSlot = () => useContext(ControlsSlot);
