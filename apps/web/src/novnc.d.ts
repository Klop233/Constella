declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean; credentials?: { password?: string } });
    viewOnly: boolean;
    scaleViewport: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    resizeSession: boolean;
    background: string;
    disconnect(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(): void;
  }
}
