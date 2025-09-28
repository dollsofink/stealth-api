import 'puppeteer-core'; // or 'puppeteer'

declare module 'puppeteer-core' {
  interface Page {
    injectScript(
      pathOrUrl: string,
      options?: {
        bypassCSP?: boolean;
        mode?: 'auto' | 'content' | 'path' | 'url';
        readyFunction?: () => unknown;
        readyTimeout?: number;
      }
    ): Promise<void>;

    injectJquery(options?: {
      jqueryPath?: string;
      bypassCSP?: boolean;
      readyTimeout?: number;
    }): Promise<void>;
  }
}