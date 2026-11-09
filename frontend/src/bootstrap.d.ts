interface Window {
  hubBoot?: {run: (mount: () => void) => void; complete: () => void; fail: () => void};
}
declare module '*?raw' {const source:string;export default source;}
